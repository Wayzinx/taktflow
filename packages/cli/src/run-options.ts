import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 每次运行实际用到的 CLI 选项：answer 默认 resume / serve onAnswer 靠它恢复原始 workflow、harness 和 mock。 */
export interface RunCliOptions {
  /** 直接以文件路径启动时的绝对路径；用 ID 启动时不写。 */
  workflowPath?: string
  harness?: string
  mock?: string
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 运行 ID 会进路径，Core 的 assertRunId 没从包入口导出，这里做同样的校验。 */
function assertRunId(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`非法运行 ID：${runId}`)
  return runId
}

const optionsFile = (taktDir: string, runId: string): string =>
  join(taktDir, 'runs', assertRunId(runId), 'cli.json')

export async function saveRunOptions(taktDir: string, runId: string, options: RunCliOptions): Promise<void> {
  await writeFile(optionsFile(taktDir, runId), JSON.stringify(options, null, 2), 'utf8')
}

export async function readRunOptions(taktDir: string, runId: string): Promise<RunCliOptions> {
  try {
    const value: unknown = JSON.parse(await readFile(optionsFile(taktDir, runId), 'utf8'))
    if (typeof value !== 'object' || value === null) return {}
    const record = value as Record<string, unknown>
    const result: RunCliOptions = {}
    if (typeof record.workflowPath === 'string') result.workflowPath = record.workflowPath
    if (typeof record.harness === 'string') result.harness = record.harness
    if (typeof record.mock === 'string') result.mock = record.mock
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`无法读取运行选项：${runId}（${error instanceof Error ? error.message : String(error)}）`)
  }
}
