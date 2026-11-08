import { canonicalJson, sha256 } from '../util/hash.js'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectStores, QualityStatus, QualityStore } from '../interfaces.js'
import type { Actor, QualityLogEntry } from '../types.js'
import { withFileLock } from '../store/file-lock.js'
import { assertNoSymlinks, readFileIfExists, readJsonFile, toJsonText, writeFileAtomic } from '../store/fs-utils.js'
import { assertRequirementId, assertRunId } from '../store/paths.js'
import { chainHash, checkAnchor, verifyChain, ZERO_HASH, type ChainAnchor } from './chain.js'
import { buildViews, defectKey, type QualityViews } from './models.js'
import { importM3, MIGRATION_KEY, type QualityInput } from './migration.js'
import { eventObservations } from './observations.js'
import { isQualityEntry, validateInput } from './validation.js'

export class QualityConflictError extends Error {
  override name = 'QualityConflictError'
}

interface CursorState { cursors: Record<string, number>; lastSyncAt?: string }
interface Ledger { entries: QualityLogEntry[]; status: QualityStatus }

export class FsQualityStore implements QualityStore {
  private readonly root: string
  private readonly log: string
  constructor(private readonly stores: ProjectStores) {
    this.root = join(stores.taktDir, 'quality')
    this.log = join(this.root, 'log.jsonl')
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await assertNoSymlinks(this.stores.taktDir, this.root)
    return withFileLock(this.log, work)
  }

  private async file(name: string): Promise<string> {
    const file = join(this.root, name)
    await assertNoSymlinks(this.stores.taktDir, file)
    return file
  }

  private async ledger(): Promise<Ledger> {
    const content = await readFileIfExists(await this.file('log.jsonl'))
    const chain = verifyChain(content?.toString('utf8') ?? '', isQualityEntry)
    let anchor: ChainAnchor | undefined
    let badAnchor = false
    try { anchor = await readJsonFile<ChainAnchor>(await this.file('anchor.json')) } catch { badAnchor = true }
    const checked = badAnchor || anchor === null ? { anchorBehind: false, brokenAt: chain.entries.length + 1 } : checkAnchor(chain.entries, anchor)
    const brokenAt = chain.brokenAt ?? checked.brokenAt
    const cursors = await this.cursorState()
    return { entries: chain.entries, status: { ok: brokenAt === undefined && !checked.anchorBehind, entries: chain.entries.length,
      anchor, anchorBehind: checked.anchorBehind, brokenAt, ...cursors,
      importedM3: chain.entries.some((e) => e.key === MIGRATION_KEY) } }
  }

  private async cursorState(): Promise<CursorState> {
    return await readJsonFile<CursorState>(await this.file('cursors.json')) ?? { cursors: {} }
  }

  private requireHealthy(ledger: Ledger): void {
    if (ledger.status.brokenAt !== undefined) throw new Error(`质量日志或锚点在第 ${ledger.status.brokenAt} 项损坏 / 截断；请保留现场并人工恢复，不能自动修复`)
    if (ledger.status.anchorBehind) throw new Error('质量日志完整但锚点落后；请提供原因并运行 quality repair 后重试')
  }

  async append(entries: QualityInput[], options?: Parameters<QualityStore['append']>[1]): ReturnType<QualityStore['append']> {
    // 在等待锁之前冻结调用者的数据，避免校验后被调用者修改。
    const input = structuredClone(entries), frozenOptions = structuredClone(options)
    return this.locked(async () => {
      const ledger = await this.ledger()
      this.requireHealthy(ledger)
      return this.commit(ledger.entries, input, frozenOptions)
    })
  }

  private async commit(existing: QualityLogEntry[], input: QualityInput[], options?: Parameters<QualityStore['append']>[1]): ReturnType<QualityStore['append']> {
    const keys = new Set(existing.map((entry) => entry.key))
    const skipped: string[] = [], fresh: QualityInput[] = []
    for (const entry of input) {
      if (keys.has(entry.key)) { skipped.push(entry.key); continue }
      validateInput(entry)
      keys.add(entry.key)
      fresh.push(entry)
    }
    // 重试一个已经提交的请求时，不再因为旧 revision 拒绝它。
    if (!fresh.length) return { appended: [], skipped }
    const views = buildViews(existing)
    if (options?.baseRevision && 'objectKind' in options.baseRevision) {
      // 样本 / 评测：比较对象内容哈希（与 eval/quality-access.ts 的 evalRevision 同口径，去掉对象里记的 baseRevision）
      const { objectKind, objectId, revision } = options.baseRevision
      const found = (objectKind === 'sample' ? views.samples : views.evaluations).find((o) => o.id === objectId)
      const { baseRevision: _base, ...plain } = (found ?? {}) as Record<string, unknown>
      if (sha256(canonicalJson(found ? plain : null)) !== revision) throw new QualityConflictError(`${objectKind === 'sample' ? '样本' : '评测'} ${objectId} 已改变；请重新读取并提交 baseRevision`)
    } else if (options?.baseRevision && 'defectId' in options.baseRevision) {
      const { defectId, revision } = options.baseRevision
      const requirements = new Set(fresh.map((entry) => entry.requirementId).filter((id) => id !== undefined))
      const matches = views.defects.filter((d) => d.id === defectId && (!requirements.size || requirements.has(d.requirementId)))
      if (matches.length !== 1 || matches[0]!.revision !== revision) throw new QualityConflictError(`缺陷 ${defectId} 版本已改变或身份不唯一；请重新读取缺陷并提交 baseRevision`)
    }
    const identities = new Set(views.defects.map((d) => defectKey(d.requirementId, d.id)))
    const observationIds = new Set(views.observations.map((o) => o.id))
    for (const entry of fresh) {
      const data = entry.data as Record<string, unknown>
      const id = defectKey(entry.requirementId ?? '', (data.id ?? data.defectId) as string)
      if (entry.kind === 'defect.created') {
        if (identities.has(id)) throw new QualityConflictError(`缺陷 ${id} 已存在；请读取后使用 defect.updated`)
        identities.add(id)
      } else if (entry.kind === 'defect.updated' || entry.kind.startsWith('attribution.')) {
        if (!identities.has(id)) throw new QualityConflictError(`缺陷 ${id} 不存在；请先创建或导入缺陷`)
      } else if (entry.kind === 'observation.recorded') {
        if (observationIds.has(data.id as string)) throw new QualityConflictError(`观察 ${data.id} 已存在；请使用原幂等键，观察不能被修改`)
        observationIds.add(data.id as string)
      }
    }
    let prevHash = existing.at(-1)?.hash ?? ZERO_HASH
    const appended = fresh.map((entry, index): QualityLogEntry => {
      const next = { ...entry, seq: existing.length + index + 1, ts: new Date().toISOString(), prevHash, hash: '' }
      next.hash = chainHash(next)
      prevHash = next.hash
      return next
    })
    const all = [...existing, ...appended]
    const nextViews = buildViews(all)
    await mkdir(this.root, { recursive: true })
    const handle = await open(await this.file('log.jsonl'), 'a')
    try { await handle.writeFile(appended.map((entry) => JSON.stringify(entry)).join('\n') + '\n'); await handle.sync() } finally { await handle.close() }
    await this.anchor(all)
    await this.writeViews(nextViews)
    return { appended, skipped }
  }

  private async anchor(entries: QualityLogEntry[]): Promise<void> {
    await writeFileAtomic(await this.file('anchor.json'), toJsonText({ seq: entries.length, hash: entries.at(-1)?.hash ?? ZERO_HASH }))
  }

  private async writeViews(views: QualityViews): Promise<void> {
    for (const [name, value] of Object.entries(views)) await writeFileAtomic(await this.file(`views/${name}.json`), toJsonText(value))
  }

  private async migrate(): Promise<void> {
    await this.locked(async () => {
      const ledger = await this.ledger()
      this.requireHealthy(ledger)
      if (ledger.status.importedM3) return
      // 已有质量日志的缺陷文件只是投影；中断的 M3 导入则仍需补齐缺失的归因。
      const known = new Set(ledger.entries.filter((entry) => entry.kind === 'defect.created' && !entry.key.startsWith('m3:defect:'))
        .map((entry) => defectKey(entry.requirementId!, (entry.data as { id: string }).id)))
      const imported = (await importM3(this.stores)).filter((entry) => {
        if (!entry.kind.startsWith('defect.') && !entry.kind.startsWith('attribution.')) return true
        const data = entry.data as Record<string, unknown>
        return !known.has(defectKey(entry.requirementId!, (data.id ?? data.defectId) as string))
      })
      await this.commit(ledger.entries, imported)
    })
  }

  async sync(runId?: string): ReturnType<QualityStore['sync']> {
    if (runId !== undefined) assertRunId(runId)
    await this.migrate()
    const runs = runId === undefined ? await this.stores.runs.list() : [await this.stores.runs.get(runId)]
    if (runs.some((run) => !run)) throw new Error(`运行不存在：${runId}；请核对 runId 后重试`)
    let observations = 0
    for (const run of runs) {
      if (!run) continue
      const verification = await this.stores.events.verify(run.runId)
      if (!verification.ok) throw new Error(`运行 ${run.runId} 的事件链损坏；请人工恢复后再同步`)
      const cursor = await this.cursorState()
      const events = await this.stores.events.read(run.runId, { afterSeq: cursor.cursors[run.runId] ?? 0 })
      for (const event of events) {
        const input = eventObservations(event, run.requirementId).map((observation): QualityInput => ({ kind: 'observation.recorded',
          key: observation.id, requirementId: run.requirementId, data: observation, actor: observation.by }))
        observations += (await this.append(input)).appended.length
        // 不持有覆盖整个 sync 的锁：追加完成后崩溃不会留下同步锁。并发重放靠 key 去重，游标在提交锁内单调推进。
        await this.locked(async () => {
          const latest = await this.cursorState()
          latest.cursors[run.runId] = Math.max(latest.cursors[run.runId] ?? 0, event.seq)
          latest.lastSyncAt = new Date().toISOString()
          await writeFileAtomic(await this.file('cursors.json'), toJsonText(latest))
        })
      }
    }
    return { observations, runs: runs.length }
  }

  private async views(): Promise<QualityViews> {
    await this.migrate()
    return this.locked(async () => {
      const ledger = await this.ledger()
      this.requireHealthy(ledger)
      const views = buildViews(ledger.entries)
      await this.writeViews(views)
      return views
    })
  }

  async observations(filter?: Parameters<QualityStore['observations']>[0]): ReturnType<QualityStore['observations']> {
    if (filter?.requirementId !== undefined) assertRequirementId(filter.requirementId)
    if (filter?.runId !== undefined) assertRunId(filter.runId)
    return (await this.views()).observations.filter((o) => (!filter?.requirementId || o.requirementId === filter.requirementId)
      && (!filter?.source || o.source === filter.source) && (!filter?.runId || o.runId === filter.runId))
  }

  async defects(requirementId?: string): ReturnType<QualityStore['defects']> {
    if (requirementId !== undefined) assertRequirementId(requirementId)
    return (await this.views()).defects.filter((d) => !requirementId || d.requirementId === requirementId)
  }

  async mergeSuggestions(requirementId?: string): ReturnType<QualityStore['mergeSuggestions']> {
    if (requirementId !== undefined) assertRequirementId(requirementId)
    return (await this.views()).merges.filter((m) => !requirementId || m.requirementId === requirementId)
  }

  async samples(): ReturnType<QualityStore['samples']> {
    return (await this.views()).samples
  }

  async evaluations(): ReturnType<QualityStore['evaluations']> {
    return (await this.views()).evaluations
  }

  async status(): Promise<QualityStatus> { return this.locked(async () => (await this.ledger()).status) }

  async repair(by: Actor, reason: string): Promise<QualityStatus> {
    if (!reason.trim()) throw new Error('修复质量锚点必须填写原因；请提供 reason')
    return this.locked(async () => {
      const ledger = await this.ledger()
      if (ledger.status.brokenAt !== undefined) this.requireHealthy(ledger)
      if (!ledger.status.anchorBehind) return ledger.status
      await this.commit(ledger.entries, [{ kind: 'recovery', key: `recovery:${randomUUID()}`, actor: by,
        data: { reason, action: 'anchor.repaired', previous: ledger.status.anchor ?? null, recoveredThrough: ledger.entries.length } }])
      return (await this.ledger()).status
    })
  }

  async rebuild(): Promise<void> {
    await this.locked(async () => {
      const ledger = await this.ledger()
      this.requireHealthy(ledger)
      await rm(await this.file('views'), { recursive: true, force: true })
      await this.writeViews(buildViews(ledger.entries))
    })
  }
}

export function createQualityStore(stores: ProjectStores): QualityStore { return new FsQualityStore(stores) }
