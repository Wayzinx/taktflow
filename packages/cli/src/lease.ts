import { acquireLease, releaseLease, renewLease, createLeaseScope, LeaseHeldError, type LeaseScopeOptions, type ProjectStores } from '@taktflow/core'
import { UsageError } from './args.js'
export { LeaseHeldError }
export type LeaseOptions = LeaseScopeOptions
export const withLease = createLeaseScope({ acquireLease, releaseLease, renewLease })
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const cliLeaseOwner = (): string => `cli:${process.pid}`

/** CLI 写命令：租约被别人持有或失效时转成参数错误，并给出下一步提示。 */
export async function withCliLease<T>(
  taktDir: string,
  task: (signal: AbortSignal) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  try {
    return await withLease(taktDir, cliLeaseOwner(), task, options)
  } catch (error) {
    if (error instanceof LeaseHeldError) {
      throw new UsageError(`${error.message}。${error.stale
        ? '租约已失效，确认没有其它进程在运行后，加 --takeover 显式接管。'
        : '请在 dsh 里操作，或在 dsh 主面板释放空间后重试。'}`)
    }
    throw error
  }
}

export interface WriteLeaseHook {
  <T>(stores: ProjectStores, fn: () => Promise<T>): Promise<T>
}

/** serve 的每次写操作（含答复后的恢复）短暂持有 serve:<pid> 租约。 */
export function createWriteLeaseHook(options: LeaseOptions = {}): WriteLeaseHook {
  return (stores, fn) => withLease(stores.taktDir, `serve:${process.pid}`, () => fn(), options)
}

export interface Interrupts {
  readonly interrupted: boolean
  /** 等待信号触发的取消完成；调用方必须在释放租约前 await。 */
  drain(): Promise<void>
  dispose(): void
}

/** Ctrl-C / SIGTERM 先触发取消，等任务收敛后由调用方释放租约；不在信号处理里直接退出。 */
export function handleInterrupts(onInterrupt: () => void | Promise<void>): Interrupts {
  let interrupted = false
  let pending: Promise<void> | undefined
  let failure: unknown
  let failed = false
  const handler = (): void => {
    if (interrupted) return
    interrupted = true
    pending = Promise.resolve().then(onInterrupt).catch((error: unknown) => {
      // 先记录再写 stderr；drain 必须把取消失败重抛给业务调用方。
      failure = error
      failed = true
      process.stderr.write(`取消运行失败：${messageOf(error)}\n`)
    })
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return {
    get interrupted() { return interrupted },
    async drain() {
      await pending
      if (failed) throw failure
    },
    dispose() {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
    },
  }
}
