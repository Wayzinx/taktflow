import { withCliLease } from '../lease.js'
import { withLock, type EventPayloads } from '@taktflow/core'
import { join } from 'node:path'
import { createPrinter } from '../output.js'
import { openStores } from '../project.js'

export async function runAuditVerify(project: string | undefined, runId: string, json: boolean, takeover = false): Promise<boolean> {
  const stores = await openStores(project)
  const printer = createPrinter(json)
  // verify 对缺失的日志返回 ok:true；先确认运行本身存在，否则会把"没跑过"误报为审计通过。
  const run = await stores.runs.get(runId)
  if (!run) {
    if (json) printer.data({ runId, ok: false, error: `运行不存在：${runId}` })
    else printer.text(`${printer.colors.red('✘')} ${runId} 不存在`)
    return false
  }
  const result = await withLock(join(stores.taktDir, 'runs', runId, 'audit'), async () => {
    const initial = await stores.events.verify(runId)
    if (!initial.ok) return { ...initial, untracked: [] }
    const untracked = await stores.workspaces.detectUntracked(run.requirementId)
    const events = await stores.events.read(runId, { types: ['artifact.untracked'] })
    const reported = new Map(events.map((event) => {
      const data = event.data as EventPayloads['artifact.untracked']
      return [data.path, data.sha256]
    }))
    for (const data of untracked) {
      if (reported.get(data.path) === data.sha256) continue
      await withCliLease(stores.taktDir, () => stores.events.append(runId, { type: 'artifact.untracked', actor: { type: 'system', id: 'audit' }, data }), { takeover })
    }
    // 追加发现记录后再校验整条链，审计记录本身也必须有效。
    const chain = await stores.events.verify(runId)
    return { ...chain, ok: chain.ok && untracked.length === 0, untracked }
  })
  if (json) {
    printer.data({ runId, ...result })
  } else {
    if (result.brokenAt !== undefined) printer.text(`${printer.colors.red('✘')} ${runId} 哈希链在第 ${result.brokenAt} 条断链`)
    else printer.text(`${printer.colors.green('✔')} ${runId} 哈希链完整`)
    for (const file of result.untracked) printer.text(`${printer.colors.red('✘')} 未登记或被直接修改的产物：${file.path} (${file.sha256})`)
  }
  return result.ok
}
