import { join } from 'node:path'
import type { AutomationRunRecord } from '../api.js'
import { appendLine, readJsonLines, writeFileAtomic } from '../store/fs-utils.js'
import { withFileLock } from '../store/file-lock.js'
import { systemWrite } from '../engine/guard.js'
import type { ProjectStores } from '../interfaces.js'

export class AutomationRecords {
  readonly file: string
  constructor(private stores: ProjectStores) { this.file = join(stores.taktDir, 'automations/runs.jsonl') }
  async list(automationId?: string, limit = Infinity): Promise<AutomationRunRecord[]> {
    const latest = new Map<string, AutomationRunRecord>()
    for (const record of await readJsonLines<AutomationRunRecord>(this.file)) latest.set(record.id, record)
    return [...latest.values()].reverse().filter(r => !automationId || r.automationId === automationId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
  }
  async write(record: AutomationRunRecord): Promise<void> {
    await systemWrite(this.stores.projectDir, ['.takt/automations/**'], () => withFileLock(this.file, async () => {
      await appendLine(this.file, JSON.stringify(record))
      const rows = await readJsonLines<AutomationRunRecord>(this.file)
      const counts = new Map<string, number>(), keep = new Set<string>()
      const latest = await this.list()
      for (const item of [...latest.filter(r => r.status === 'running'), ...latest.filter(r => r.status !== 'running')]) {
        const count = (counts.get(item.automationId) ?? 0) + 1
        counts.set(item.automationId, count)
        if (count <= 200) keep.add(item.id)
      }
      if (rows.some(r => !keep.has(r.id))) await writeFileAtomic(this.file, rows.filter(r => keep.has(r.id)).map(r => JSON.stringify(r)).join('\n') + '\n')
    }))
  }
  async recover(): Promise<void> {
    for (const record of await this.list()) if (record.status === 'running') await this.write({ ...record, status: 'failed', summary: 'serve 重启，执行中断', error: 'serve 重启，执行中断', durationMs: Math.max(0, Date.now() - Date.parse(record.at)) })
  }
}
