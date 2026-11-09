import type { StewardContextRef, StewardFindResult, StewardFindType, StewardPrefs } from '../api.js'
import type { RunState } from '../types.js'
import { entityRun, entitySnapshot, pipelineRuns } from './entity.js'
import { type StewardDeps, type StewardSpace, StewardError, timestamp } from './contracts.js'

export const FIND_TYPES: StewardFindType[] = ['space', 'requirement', 'run', 'node', 'workflow', 'knowledge']
export interface StewardFindInput { q: string; types?: StewardFindType[]; spaceId?: string; limit?: number }

export function findLimit(value: unknown, fallback = 8): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new StewardError(400, 'limit 必须是正整数，请修改后重试')
  return Math.min(value, 20)
}
export function findInput(input: Record<string, unknown>): StewardFindInput {
  if (typeof input.q !== 'string' || !input.q.trim()) throw new StewardError(400, 'q 不能为空，请输入编号或标题后重试')
  if (input.types !== undefined && (!Array.isArray(input.types) || !input.types.length || input.types.some(type => !FIND_TYPES.includes(type as StewardFindType)))) throw new StewardError(400, 'types 不合法，请选择 space、requirement、run、node、workflow 或 knowledge')
  if (input.spaceId !== undefined && (typeof input.spaceId !== 'string' || !input.spaceId.trim())) throw new StewardError(400, 'spaceId 不能为空，请重新选择空间')
  return { q: input.q.trim(), types: input.types as StewardFindType[] | undefined, spaceId: input.spaceId as string | undefined, limit: findLimit(input.limit) }
}

export function entityQuery(text: string): string {
  return text.toLowerCase().replace(/req[\s-]*0*(\d+)/gi, (_, n: string) => `req-${Number(n)}`)
    .replace(/(?:progress|status|attention|todo|risk|风险|验收还差|处理什么|我要处理|现在|那个|这个|需求|到哪了|到哪|怎么样了?|咋样了?|有什么|哪些|什么|正在|在跑什么|卡在哪|卡住|失败|进度|进展|状态|阶段|运行图|流程图|节点图|画布|dag|运行|节点|等我决定|等我|待办|审批|要我决定|配置|帮我|看下|看看|请问|的|了|吗)/gi, '')
    .replace(/[\s，。？！?！!：:、]+/g, '').trim()
}
const canonical = (id: string) => id.toLowerCase().replace(/^req[\s-]*0*(\d+)$/, (_, n: string) => `req-${Number(n)}`)
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) return [...a].filter((char, index) => char !== b[index]).length === 1
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  let i = 0, j = 0, edits = 0
  while (j < long.length) {
    if (short[i] === long[j]) { i++; j++ } else { j++; edits++ }
    if (edits > 1) return false
  }
  return edits === 1
}
type Match = { score: number; match: 'id' | 'title' | 'recent'; why: string }
type Hit = Match & { ref: StewardContextRef; space: StewardSpace; activity: () => Promise<string>; updatedAt?: string }
function matchEntity(q: string, id: string, title: string, type: StewardFindType, identities: Set<string>): Match | undefined {
  const key = canonical(id), token = type === 'requirement' ? q.match(/req-\d+/)?.[0] : type === 'run' ? q.match(/run-[\w.-]+/)?.[0] : undefined
  if (identities.has(key) || q === key || token === key || type === 'node' && q.replace(/req-\d+/g, '') === key) return { score: 100, match: 'id', why: '编号命中' }
  if (type === 'run' && /^\d+$/.test(q) && id.endsWith(q)) return { score: 95, match: 'id', why: '运行尾号命中' }
  if (token && oneEdit(token, key)) return { score: 78, match: 'id', why: '编号相差一位，请核对' }
  if (token && type === 'requirement') return undefined
  const needle = q.replace(/req-\d+/g, ''), haystack = entityQuery(title)
  if (!needle) return q ? undefined : { score: 1, match: 'recent', why: '最近有动静' }
  if (haystack.includes(needle) || (haystack.length >= 2 && needle.includes(haystack))) return { score: 70, match: 'title', why: `标题含「${needle}」` }
  const pairs = new Set([...needle].slice(1).map((char, i) => `${needle[i]}${char}`))
  const hits = [...pairs].filter(pair => haystack.includes(pair)).length
  const ratio = hits / pairs.size
  return hits && ratio >= 0.3 ? { score: 40 + 25 * ratio, match: 'title', why: `标题与「${needle}」相近` } : undefined
}

/** 结束的运行以结束时间为准（恢复运行会清掉 endedAt）；只有没结束的才读事件找最后动静。 */
export async function runActivityAt(space: StewardSpace, run: RunState): Promise<string> {
  if (run.endedAt) return [run.startedAt, run.endedAt].sort().at(-1)!
  const events = await space.stores.events.read(run.runId)
  return [run.startedAt, ...events.map(event => event.ts)].sort().at(-1)!
}
export async function requirementActivityAt(space: StewardSpace, id: string, updatedAt: string): Promise<string> {
  const runs = await space.stores.runs.list({ requirementId: id })
  return [updatedAt, ...await Promise.all(runs.map(run => runActivityAt(space, run)))].sort().at(-1)!
}

export async function findEntities(deps: StewardDeps, input: StewardFindInput, prefs: StewardPrefs, context: StewardContextRef[] = []): Promise<StewardFindResult> {
  const options = findInput({ ...input })
  const q = entityQuery(options.q), types = new Set(options.types ?? FIND_TYPES)
  // 编号不能跟着意图词被删掉，例如名为 status 或 risk-alert 的流程。
  const rawIdQuery = options.q.toLowerCase().replace(/req[\s-]*0*(\d+)/gi, (_, n: string) => `req-${Number(n)}`)
  const identities = new Set([rawIdQuery.trim(), ...(rawIdQuery.match(/[a-z0-9_./-]+/g) ?? [])])
  const spaces = (await deps.spaces()).filter(space => !space.archived && !prefs.mutedSpaces?.includes(space.id) && (!options.spaceId || space.id === options.spaceId))
  // 先只比编号和标题；最近动静和快照只给可能进前 limit 的候选算（读事件、建运行图都不便宜）
  const hits: Hit[] = []
  for (const summary of spaces) {
    const space = await deps.open(summary.id)
    const add = (type: StewardFindType, id: string, title: string, activity: () => Promise<string>, parent?: string, idOnly = false) => {
      if (!types.has(type)) return
      const matched = matchEntity(q, id, title, type, identities)
      if (!matched || idOnly && matched.match !== 'id') return
      const ref: StewardContextRef = { type, id, spaceId: space.id, ...(parent ? { parent } : {}) }
      const boost = context.some(item => item.spaceId === space.id || item.type === 'space' && item.id === space.id) ? 3 : 0
      const exactContext = context.some(item => item.type === type && item.id === id && item.spaceId === space.id && item.parent === parent) ? 5 : 0
      hits.push({ ...matched, score: matched.score + boost + exactContext, ref, space, activity })
    }
    add('space', space.id, space.name, async () => summary.lastActivityAt ?? '')
    for (const req of await space.stores.workspaces.listRequirements()) {
      // 已归档的只按编号找，不让旧标题和在做的需求抢成歧义
      add('requirement', req.id, req.title, () => requirementActivityAt(space, req.id, req.updatedAt), undefined, req.status === 'archived')
      if (!types.has('node')) continue
      const matched = matchEntity(q, req.id, req.title, 'requirement', identities)
      if (!matched && !context.some(ref => ref.type === 'requirement' && ref.id === req.id && ref.spaceId === space.id)) continue
      const latest = (await pipelineRuns(space, req.id))[0]
      if (!latest) continue
      const detail = await entityRun(space, latest.runId)
      for (const node of detail.graph.nodes) add('node', node.id, node.title, () => runActivityAt(space, latest), latest.runId)
    }
    if (types.has('run')) for (const run of await space.stores.runs.list()) {
      const workflow = await space.stores.runs.getWorkflow(run.runId)
      if (workflow) add('run', run.runId, workflow.title, () => runActivityAt(space, run))
    }
    if (types.has('workflow')) for (const workflow of await space.workflows.list?.({ record: false }) ?? []) add('workflow', workflow.id, workflow.title, async () => workflow.updatedAt)
    if (types.has('knowledge')) for (const base of await space.stores.kb?.list() ?? []) add('knowledge', base.id, base.name, async () => base.updatedAt)
  }
  hits.sort((a, b) => b.score - a.score)
  const floor = hits[options.limit! - 1]?.score ?? -Infinity
  const ranked = hits.filter(hit => hit.score >= floor)
  for (const hit of ranked) hit.updatedAt = await hit.activity()
  ranked.sort((a, b) => b.score - a.score || b.updatedAt!.localeCompare(a.updatedAt!) || `${a.ref.spaceId}/${a.ref.type}/${a.ref.id}`.localeCompare(`${b.ref.spaceId}/${b.ref.type}/${b.ref.id}`))
  const [first, second] = ranked
  const ambiguous = Boolean(first && second && (first.score - second.score < first.score * 0.15 || first.match === 'title' && second.match === 'title' && first.score - second.score <= 10))
  const at = timestamp(deps)
  const items = []
  for (const hit of ranked.slice(0, options.limit)) items.push({ ref: hit.ref, snapshot: await entitySnapshot(hit.space, hit.ref, at), score: hit.score, match: hit.match, why: hit.why })
  return { items, ambiguous }
}
