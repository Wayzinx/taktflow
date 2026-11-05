import { createEngine } from '@taktflow/core'
import type { ParsedCli } from '../args.js'
import { createPrinter } from '../output.js'
import { openStores } from '../project.js'
import { handleInterrupts, withCliLease } from '../lease.js'

/** 取消等待中或已中断的运行：只改状态、答复待办，不重新执行节点。 */
export async function runCancel(cli: ParsedCli): Promise<number> {
  const options = cli.options
  const runId = cli.positionals[0]!
  const stores = await openStores(options.project)
  const printer = createPrinter(options.json)
  // 不让 SIGINT 直接退出，保证 finally 里能释放租约。
  const interrupts = handleInterrupts(() => undefined)
  try {
    const state = await withCliLease(stores.taktDir, async () => {
      if (!await stores.runs.get(runId)) throw new Error(`运行不存在：${runId}`)
      const engine = createEngine({ stores, harnesses: {}, profiles: {}, knowledge: [] })
      await engine.cancel(runId)
      return stores.runs.get(runId)
    }, { takeover: options.takeover })
    if (printer.json) printer.data(state)
    else if (state?.status === 'cancelled') {
      printer.text(`${printer.colors.green('✔')} 已取消运行 ${printer.colors.cyan(runId)}`)
    } else {
      printer.text(`运行 ${runId} 已结束（${state?.status ?? 'unknown'}），无需取消`)
    }
    return interrupts.interrupted ? 130 : 0
  } finally {
    interrupts.dispose()
  }
}
