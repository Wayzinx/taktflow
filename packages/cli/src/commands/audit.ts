import { createPrinter } from '../output.js'
import { openStores } from '../project.js'

export async function runAuditVerify(project: string | undefined, runId: string, json: boolean): Promise<boolean> {
  const stores = await openStores(project)
  const printer = createPrinter(json)
  // verify 对缺失的日志返回 ok:true；先确认运行本身存在，否则会把"没跑过"误报为审计通过。
  if (!await stores.runs.get(runId)) {
    if (json) printer.data({ runId, ok: false, error: `运行不存在：${runId}` })
    else printer.text(`${printer.colors.red('✘')} ${runId} 不存在`)
    return false
  }
  const result = await stores.events.verify(runId)
  if (json) {
    printer.data({ runId, ...result })
  } else if (result.ok) {
    printer.text(`${printer.colors.green('✔')} ${runId} 哈希链完整`)
  } else {
    printer.text(`${printer.colors.red('✘')} ${runId} 哈希链在第 ${result.brokenAt ?? '?'} 条断链`)
  }
  return result.ok
}
