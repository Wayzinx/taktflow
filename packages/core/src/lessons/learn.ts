import type { ProjectStores } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, Lesson, RunState, SnapshotNode, VerdictCategory } from '../types.js'
import { loadProfiles } from '../store/project.js'
import { withFileLock } from '../store/file-lock.js'
import { join } from 'node:path'
import { sha256 } from '../util/hash.js'
import { readReviewRounds } from '../insights/review-rounds.js'
import { isObject } from '../insights/artifacts.js'
import { orderedEvents } from '../insights/usage.js'

const categories = new Set<VerdictCategory>(['product_bug', 'script_defect', 'case_defect', 'env_issue', 'test_data', 'deployment'])
const by = { type: 'system', id: 'lessons' } as const
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const signature = (text: string) => escape(text.split('\n')[0]!.trim().toLowerCase().replace(/\s+/g, ' '))
type Candidate = Omit<Lesson, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'stats'>

function definitions(nodes: SnapshotNode[], prefix = ''): SnapshotNode[] {
  return nodes.flatMap(node => [{ ...node, id: prefix + node.id }, ...definitions(node.body ?? [], `${prefix}${node.id}/`)])
}
function resolveNode(id: string, from: string, nodes: Map<string, SnapshotNode>): string {
  let scope = from.slice(0, from.lastIndexOf('/') + 1)
  while (scope) {
    if (nodes.has(scope + id)) return scope + id
    scope = scope.slice(0, -1).slice(0, scope.slice(0, -1).lastIndexOf('/') + 1)
  }
  return id
}
function repaired(events: EventEnvelope[], after: number, fixer: string, target: string, subject: string): boolean {
  const fixed = events.find(event => event.seq > after && event.nodeId === fixer && event.type === 'node.finished'
    && (event.data as EventPayloads['node.finished']).status === 'succeeded')
  if (!fixed) return false
  const checked = events.filter(event => event.seq > fixed.seq && event.nodeId === target && event.type === 'node.finished').at(-1)
  if (!checked) return false
  const data = checked.data as EventPayloads['node.finished']
  if (data.status !== 'succeeded' || !isObject(data.result)) return false
  if (Array.isArray(data.result.cases)) return data.result.cases.some(item => isObject(item) && item.id === subject && item.status === 'passed')
  return typeof data.result.total === 'number' && data.result.total > 0 && Array.isArray(data.result.failures)
    && !data.result.failures.some(failure => isObject(failure) && failure.subject === subject)
}
function safe(candidate: Candidate, ids: string[]): boolean {
  const text = `${candidate.title}\n${candidate.body}`
  if (/跳过\s*(?:验证|测试|校验)|绕过|无需\s*(?:测试|验证)|bypass|skip[\s_-]+(?:verification|tests?|validation)|(?:修改|更改|禁用|删除)\s*(?:workflow|工作流|门禁)/i.test(text)) return false
  return !ids.some(id => new RegExp(`(^|[^a-zA-Z0-9_/-])${escape(id)}($|[^a-zA-Z0-9_/-])`, 'i').test(text))
}
function dedupKey(lesson: Pick<Lesson, 'trigger'>): string {
  return sha256(JSON.stringify([...(lesson.trigger.signatures ?? [])].sort()) + JSON.stringify([...(lesson.trigger.roles ?? [])].sort())).slice(0, 24)
}

export async function learnFromRun(options: {
  stores: ProjectStores; runId: string
  model?: (prompt: string) => Promise<string>
  dailyCalls?: number
}): Promise<Lesson[]> {
  const { stores, runId } = options
  if (!stores.lessons || stores.config.lessons?.enabled === false) return []
  const store = stores.lessons
  const [run, snapshot, rawEvents] = await Promise.all([stores.runs.get(runId), stores.runs.getWorkflow(runId), stores.events.read(runId)])
  if (!run || !snapshot) throw new Error(`运行或工作流快照不存在：${runId}`)
  if (run.status === 'running' || run.status === 'waiting_human') return []
  const events = orderedEvents(rawEvents.filter(event => event.runId === runId))
  const nodes = new Map([...definitions(snapshot.nodes), ...run.expansions.flatMap(expansion => definitions(expansion.nodes ?? []))].map(node => [node.id, node]))
  const profiles = await loadProfiles(stores.paths)
  const candidates: Candidate[] = []
  for (const event of events) {
    if (event.type !== 'judge.verdict' || !event.nodeId) continue
    const judge = nodes.get(event.nodeId)
    if (!judge?.target) continue
    const target = resolveNode(judge.target, judge.id, nodes)
    const data = event.data as EventPayloads['judge.verdict']
    for (const verdict of data.verdicts) {
      const route = data.routed.find(route => route.subject === verdict.subject)?.to
      if (!categories.has(verdict.category) || !route || route === 'human' || route === 'ignore') continue
      const fixer = resolveNode(route, judge.id, nodes)
      if (!repaired(events, event.seq, fixer, target, verdict.subject)) continue
      const role = nodes.get(fixer)?.role
      if (!role) continue
      const failed = events.filter(item => item.seq < event.seq && item.nodeId === target && item.type === 'node.finished').at(-1)
      const result = failed ? (failed.data as EventPayloads['node.finished']).result : undefined
      const failure = isObject(result) && Array.isArray(result.failures) ? result.failures.find(value => isObject(value) && value.subject === verdict.subject) : undefined
      const message = isObject(failure) ? [failure.error, failure.message].find(value => typeof value === 'string') as string | undefined : undefined
      candidates.push({ title: `${verdict.category}：${verdict.subject}`, body: [verdict.rationale, verdict.fixHint].filter(Boolean).join('\n'),
        trigger: { roles: [role], paths: profiles[role]?.writeScope, signatures: [signature(message || verdict.rationale)], categories: [verdict.category] },
        source: { kind: 'judge', runId, nodeId: judge.id } })
    }
  }
  await reviewCandidates(stores, run, nodes, candidates)
  const internalIds = [...nodes.values()].filter(node => node.kind === 'gate' || node.kind === 'human').flatMap(node => [node.id, ...(node.checks ?? []).map(check => check.id)])
  for (const event of events) if (event.type === 'human.requested') internalIds.push((event.data as EventPayloads['human.requested']).requestId)
  return withFileLock(join(stores.paths.knowledge, 'lessons-learning'), async () => {
    const existing = new Set((await store.list()).map(dedupKey))
    const learned: Lesson[] = []
    for (const candidate of candidates) {
      const key = dedupKey(candidate)
      if (!candidate.trigger.signatures?.[0] || existing.has(key) || !safe(candidate, internalIds)) continue
      const lesson = await store.upsert({ ...candidate, id: `lesson-${key}`, status: 'tentative', stats: { recalled: 0, helped: 0, hurt: 0 } }, by, '运行结束后提炼经验')
      await stores.events.append(runId, { type: 'lesson.learned', actor: by, nodeId: candidate.source.nodeId, data: { id: lesson.id, title: lesson.title, source: lesson.source } })
      learned.push(lesson)
      existing.add(key)
    }
    return learned
  })
}

async function reviewCandidates(stores: ProjectStores, run: RunState, nodes: Map<string, SnapshotNode>, candidates: Candidate[]): Promise<void> {
  const seen = new Map<string, Set<string>>()
  for (const { nodeId, round } of await readReviewRounds({ store: stores.workspaces, requirementId: run.requirementId }, new Set([run.runId]))) {
    const role = nodes.get(nodeId)?.review?.author
    if (!role) continue
    for (const record of round.records) for (const issue of record.issues) {
      const group = issue.groupKey ?? `${issue.location ?? ''}:${signature(issue.description)}`
      const key = JSON.stringify([nodeId, group])
      const rounds = seen.get(key) ?? new Set<string>()
      rounds.add(JSON.stringify([round.revision ?? 1, round.round, round.records[0]?.at]))
      seen.set(key, rounds)
      if (rounds.size < 2 && !round.continuity?.some(item => item.groupKey === group && item.regressed)) continue
      const location = issue.location?.replace(/(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, '')
      candidates.push({ title: issue.title ?? issue.description.slice(0, 40), body: [issue.description, issue.suggestion].filter(Boolean).join('\n'),
        trigger: { roles: [role], paths: location ? [location] : undefined, signatures: [signature(issue.description)] },
        source: { kind: 'review', runId: run.runId, nodeId } })
    }
  }
}
