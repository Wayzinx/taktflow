import path from 'node:path'
import type { EventStore } from '../interfaces.js'
import type { EventEnvelope } from '../types.js'
import type { Candidate, DefectView, EvalCaseView, QualityEventType } from '../quality.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { withFileLock } from './file-lock.js'
import { assertNoSymlinks, readFileIfExists, toJsonText, writeFileAtomic } from './fs-utils.js'
import { ZERO_HASH } from './hash-chain.js'
import { candidateId, prepareCandidate, storedCandidate } from './quality-candidates.js'
import { inspectQualityLog, makeQualityEvents, validQualityInput, writeQualityEvents } from './quality-log.js'
import { applyQualityEvent, checkRevision, cursorKey, reduceQuality, type QualityViews } from './quality-views.js'
import type { CandidateInput, QualityAppendOptions, QualityBatch, QualityCommit, QualityCursor, QualityCursorKey,
  QualityEventEnvelope, QualityEventInput, QualityStore } from './quality-store.js'

function content(event: QualityEventInput): string { return canonicalJson({ type: event.type, actor: event.actor, data: event.data }) }

export class FsQualityStore implements QualityStore {
  private readonly dir: string
  private readonly file: string
  private readonly anchor: string
  constructor(private readonly taktDir: string) {
    this.dir = path.join(taktDir, 'quality')
    this.file = path.join(this.dir, 'log.jsonl')
    this.anchor = path.join(this.dir, 'chain.json')
  }

  private async locked<T>(task: () => Promise<T>): Promise<T> {
    await assertNoSymlinks(this.taktDir, this.file)
    await assertNoSymlinks(this.taktDir, this.anchor)
    return withFileLock(this.file, task)
  }

  private async trustedEvents(): Promise<QualityEventEnvelope[]> {
    const state = await inspectQualityLog(this.file, this.anchor)
    if (!state.verification.ok) throw new Error(`质量日志不可用：${state.verification.reason}，seq=${state.verification.brokenAt}；请先校验并修复`)
    return state.events
  }

  async append(events: QualityEventInput[], options: QualityAppendOptions): Promise<QualityCommit> {
    // 入锁前冻结参数，排队期间调用方的对象修改不能影响一次提交。
    const inputs = JSON.parse(canonicalJson(events)) as QualityEventInput[]
    const opts = structuredClone(options)
    return this.locked(async () => this.commit(await this.trustedEvents(), inputs, opts))
  }

  private async commit(existing: QualityEventEnvelope[], inputs: QualityEventInput[], options: QualityAppendOptions): Promise<QualityCommit> {
    if (inputs.length !== options.idempotencyKeys.length) throw new Error('idempotencyKeys 必须与事件一一对应')
    const seen = new Map<string, QualityEventInput>(existing.map((event) => [event.idempotencyKey, event]))
    const pending: Array<{ event: QualityEventInput; key: string }> = []
    for (const [index, event] of inputs.entries()) {
      const key = options.idempotencyKeys[index]!
      if (!validQualityInput(event) || typeof key !== 'string' || !key) throw new Error('质量事件或幂等键不合法（人 actor 必须带 via）')
      if (event.type === 'observation.recorded' && key !== event.data.id) throw new Error('观察幂等键必须等于 observation.id')
      const previous = seen.get(key)
      if (previous) {
        if (content(previous) !== content(event)) throw new Error(`幂等键对应的事件内容不同：${key}`)
        continue
      }
      seen.set(key, event)
      pending.push({ event, key })
    }
    const views = reduceQuality(existing)
    if (pending.length) for (const [key, baseRevision] of Object.entries(options.baseRevisions ?? {})) checkRevision(views, key, baseRevision)
    const appended = makeQualityEvents(pending, existing.at(-1))
    // 整批先验证、归并，再写任何日志；批次中后一条冲突不能留下前一条。
    for (const event of appended) applyQualityEvent(views, event)
    for (const event of appended) if (event.type === 'candidate.created') await prepareCandidate(this.taktDir, event.data.candidate)
    await writeQualityEvents(this.file, this.anchor, appended)
    const all = [...existing, ...appended]
    await this.cacheCursors(views, all)
    const byKey = new Map(all.map((event) => [event.idempotencyKey, event]))
    return { events: options.idempotencyKeys.map((key) => byKey.get(key)!), appended: appended.length,
      revision: all.at(-1)?.seq ?? 0, revisions: Object.fromEntries(views.revisions) }
  }

  async verify() { return this.locked(async () => (await inspectQualityLog(this.file, this.anchor)).verification) }

  async repair(reason = '质量日志追加后链尾锚点未更新'): Promise<QualityCommit> {
    return this.locked(async () => {
      const state = await inspectQualityLog(this.file, this.anchor)
      if (state.verification.reason !== 'incomplete') throw new Error(`拒绝修复质量日志：${state.verification.reason ?? '日志完整，无需修复'}`)
      reduceQuality(state.events)
      const last = state.events.at(-1)!
      const event: QualityEventInput = { type: 'log.recovered', actor: { type: 'system', id: 'quality-repair' }, data: { seq: last.seq, reason } }
      // 恢复审计与补锚点使用同一锁；先写审计再推进锚点，重启不会漏记恢复。
      return this.commit(state.events, [event], { idempotencyKeys: [`log.recovered:${last.seq}:${last.hash}`] })
    })
  }

  async read(options?: { afterSeq?: number; types?: QualityEventType[] }): Promise<QualityEventEnvelope[]> {
    return this.locked(async () => (await this.trustedEvents()).filter((event) => event.seq > (options?.afterSeq ?? 0)
      && (!options?.types?.length || options.types.includes(event.type))))
  }

  private async cache(name: string, data: unknown, events: QualityEventEnvelope[]): Promise<void> {
    const file = path.join(this.dir, name)
    await assertNoSymlinks(this.taktDir, file)
    const value = toJsonText({ version: 1, seq: events.at(-1)?.seq ?? 0, hash: events.at(-1)?.hash ?? ZERO_HASH, data })
    if ((await readFileIfExists(file))?.toString('utf8') !== value) await writeFileAtomic(file, value)
  }

  private async cacheCursors(views: QualityViews, events: QualityEventEnvelope[]): Promise<void> {
    await this.cache('cursors.json', Object.fromEntries(views.cursors), events)
  }

  private async views(): Promise<QualityViews> {
    return this.locked(async () => {
      const events = await this.trustedEvents()
      const views = reduceQuality(events)
      // 缓存永远不反向决定事实；一期从日志重建，损坏或被删除的缓存直接替换。
      for (const name of ['defects', 'observations', 'evalcases', 'candidates', 'evals'] as const) await this.cache(`views/${name}.json`, [...views[name].values()], events)
      await this.cache('views/attributions.json', [...views.defects.values()].filter((item) => item.attribution)
        .map((item) => ({ defectId: item.id, attribution: item.attribution })), events)
      await this.cacheCursors(views, events)
      return views
    })
  }

  async rebuild(): Promise<void> { await this.views() }
  async defects(filter?: { id?: string; requirement?: string; status?: DefectView['validity'] | DefectView['resolution'] }) {
    return [...(await this.views()).defects.values()].filter((item) => (!filter?.id || item.id === filter.id)
      && (!filter?.requirement || item.requirementId === filter.requirement)
      && (!filter?.status || item.validity === filter.status || item.resolution === filter.status))
  }
  async defect(id: string) { return (await this.views()).defects.get(id) }
  async observations(filter?: { requirement?: string; run?: string; issueKey?: string }) {
    return [...(await this.views()).observations.values()].filter((item) => (!filter?.requirement || item.requirementId === filter.requirement)
      && (!filter?.run || item.runId === filter.run) && (!filter?.issueKey || item.issueKey === filter.issueKey))
  }
  async evalcases(filter?: { status?: EvalCaseView['status'] }) {
    return [...(await this.views()).evalcases.values()].filter((item) => !filter?.status || item.status === filter.status)
  }
  async candidates() { return [...(await this.views()).candidates.values()] }
  async evals() { return [...(await this.views()).evals.values()] }
  async eval(evalId: string) { return (await this.views()).evals.get(evalId) }

  async createCandidate(input: CandidateInput): Promise<Candidate> {
    const frozen = JSON.parse(canonicalJson(input)) as CandidateInput
    return this.locked(async () => {
      const events = await this.trustedEvents()
      const id = candidateId(frozen)
      const candidate = reduceQuality(events).candidates.get(id) ?? await storedCandidate(this.taktDir, frozen)
        ?? { ...frozen, candidateId: id, createdAt: frozen.createdAt ?? new Date().toISOString() }
      await prepareCandidate(this.taktDir, candidate)
      await this.commit(events, [{ type: 'candidate.created', actor: candidate.createdBy, data: { candidate } }], { idempotencyKeys: [`candidate:${id}`] })
      return candidate
    })
  }

  async getCursor(key: QualityCursorKey): Promise<number> {
    return this.locked(async () => {
      const events = await this.trustedEvents()
      const views = reduceQuality(events)
      await this.cacheCursors(views, events)
      return views.cursors.get(cursorKey(key))?.seq ?? 0
    })
  }

  async advanceCursor(cursor: QualityCursor, batch: QualityBatch): Promise<QualityCommit> {
    return this.append([...batch.events, { type: 'cursor.advanced', actor: { type: 'system', id: cursor.processor }, data: cursor }], {
      baseRevisions: batch.baseRevisions,
      idempotencyKeys: [...batch.idempotencyKeys, `cursor:${sha256(cursorKey(cursor))}:${cursor.seq}`],
    })
  }

  async replayFromCursor(events: EventStore, key: QualityCursorKey, process: (event: EventEnvelope) => Promise<QualityBatch>): Promise<number> {
    let seq = await this.getCursor(key)
    const verification = await events.verify(key.runId)
    if (!verification.ok) throw new Error(`源运行日志校验失败：${key.runId}，seq=${verification.brokenAt}`)
    for (const event of await events.read(key.runId, { afterSeq: seq })) {
      await this.advanceCursor({ ...key, seq: event.seq }, await process(event))
      seq = event.seq
    }
    return seq
  }
}
