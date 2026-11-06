import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, ArtifactVersion, EventPayloads } from '../types.js'
import type { DefectView, Observation } from '../quality.js'
import { extractTraceIds } from '../util/trace-ids.js'
import { artifactKey, comparePoints, defectContext, eventLabel, eventPoint, eventsOf, type InvocationEvidence, type QualityData } from './quality-data.js'
import { retrieveText, unifiedDiff, type TextRetrieval, type VersionDiff } from './quality-text.js'

export interface AttributionCandidate {
  id: string
  artifact: ArtifactRef
  version?: ArtifactVersion
  human: boolean
  traceIds: string[]
  touches: Array<EventPayloads['artifact.touched'] & { evidence: string; call?: InvocationEvidence }>
  previous?: ArtifactRef
  diff: VersionDiff
  retrieval: { current: TextRetrieval; previous: TextRetrieval }
  notes: string[]
}

export interface ResultCandidate {
  id: string
  from: { runId: string; nodeId: string; attempt: number }
  object: string
  content?: string
  truncated: boolean
  calls: InvocationEvidence[]
  retrieval: TextRetrieval
  notes: string[]
}

export interface AttributionCandidates {
  defectId: string
  revision: number
  status: 'candidate' | 'unknown'
  judgment: false
  roots: ArtifactRef[]
  candidates: AttributionCandidate[]
  results: ResultCandidate[]
  edges: Array<{ from: string; to: string; relation: 'previous' | 'derivedFrom' | 'input' | 'result'; invocationId?: string }>
  notes: string[]
}

export async function attributionCandidates(stores: ProjectStores, defectId: string): Promise<AttributionCandidates> {
  const context = await defectContext(stores, defectId)
  return candidateGraph(context.data, context.defect, context.linked, context.query)
}

export async function candidateGraph(data: QualityData, defect: DefectView, linked: Observation[], query: string): Promise<AttributionCandidates> {
  const roots = data.reviewedArtifacts(linked)
  const view: AttributionCandidates = { defectId: defect.id, revision: defect.revision, status: roots.length ? 'candidate' : 'unknown', judgment: false,
    roots, candidates: [], results: [], edges: [], notes: ['生产、复用、文本命中均为候选证据；不能证明引入点，须由人确认版本差异。'] }
  const visited = new Set<string>(), expandedCalls = new Set<string>()
  const cutoff = linked.map((item) => data.observationPoint(item)).sort(comparePoints).at(-1)
  const touches = eventsOf(data.events, 'artifact.touched').filter((event) => !cutoff || comparePoints(eventPoint(event), cutoff) <= 0)

  async function link(from: string, ref: ArtifactRef, relation: AttributionCandidates['edges'][number]['relation'], invocationId?: string) {
    const to = artifactKey(ref)
    if (to === from) return
    if (!view.edges.some((edge) => edge.from === from && edge.to === to && edge.relation === relation && edge.invocationId === invocationId)) {
      view.edges.push({ from, to, relation, invocationId })
    }
    await visit(ref)
  }

  async function expandCall(parent: string, call: InvocationEvidence) {
    const callKey = JSON.stringify([parent, call.invocation.invocationId])
    if (expandedCalls.has(callKey)) return
    expandedCalls.add(callKey)
    for (const input of call.inputSnapshot.inputs) await link(parent, input.ref, 'input', call.invocation.invocationId)
    for (const result of call.inputSnapshot.results ?? []) {
      const id = `result:${JSON.stringify([result.from.runId, result.from.nodeId, result.from.attempt, result.object])}`
      view.edges.push({ from: parent, to: id, relation: 'result', invocationId: call.invocation.invocationId })
      if (visited.has(id)) continue
      visited.add(id)
      const calls = [...data.invocations.values()].filter((item) => item.invocation.runId === result.from.runId
        && item.invocation.nodeId === result.from.nodeId && item.invocation.attempt === result.from.attempt
        && comparePoints(eventPoint(item.event), eventPoint(call.event)) < 0)
      const content = await data.object(result.object)
      view.results.push({ id, ...result, content: content?.slice(0, 16_000), truncated: (content?.length ?? 0) > 16_000,
        calls, retrieval: retrieveText(content ?? '', query), notes: [
          '结构化结果只冻结到 run/node/attempt；列出该 attempt 的调用，不擅自指定唯一生产调用。',
          ...(!calls.length ? ['没有该结果来源的调用记录（可能是脚本或历史缺失）。'] : []),
          ...(content === undefined ? ['结果正文对象缺失。'] : []),
        ] })
      for (const upstream of calls) await expandCall(id, upstream)
    }
  }

  async function visit(ref: ArtifactRef): Promise<void> {
    const id = artifactKey(ref)
    if (visited.has(id)) return
    visited.add(id)
    const { record, version } = await data.version(ref)
    const related = touches.filter((event) => artifactKey(event.data.ref) === id)
    const prior = version && record?.versions.filter((item) => item.version < version.version).sort((a, b) => b.version - a.version)[0]
    const previous = prior ? { ...ref, version: prior.version } : undefined
    const [content, before] = await Promise.all([data.text(ref), previous ? data.text(previous) : Promise.resolve(version?.version === 1 ? '' : undefined)])
    const candidate: AttributionCandidate = { id, artifact: ref, version, human: version?.author.type === 'human',
      traceIds: extractTraceIds(content ?? ''), previous,
      diff: unifiedDiff(before, content, previous ? `${ref.path}@${previous.version}` : '/dev/null', `${ref.path}@${ref.version ?? 'unknown'}`),
      touches: related.map((event) => ({ ...event.data, evidence: eventLabel(event), call: event.data.invocationId ? data.invocations.get(event.data.invocationId) : undefined })),
      retrieval: { current: retrieveText(content ?? '', query), previous: retrieveText(before ?? '', query) }, notes: [] }
    view.candidates.push(candidate)
    if (!version) candidate.notes.push('缺少明确的历史版本；不会读取最新版代替。')
    if (content === undefined) candidate.notes.push('版本正文缺失或不是文本，差异与检索不可用。')
    if (!related.length) candidate.notes.push('没有调用级触碰记录；保留版本元数据，不由 producedBy 猜测 invocation。')
    if (previous) await link(id, previous, 'previous')
    for (const upstream of version?.derivedFrom ?? []) await link(id, upstream, 'derivedFrom')
    for (const touch of candidate.touches) {
      if (touch.previous) await link(id, touch.previous, 'previous', touch.invocationId)
      if (touch.call) await expandCall(id, touch.call)
      else if (touch.invocationId) candidate.notes.push(`调用记录缺失：${touch.invocationId}`)
    }
  }

  for (const root of roots) await visit(root)
  if (!roots.length) view.notes.push('关联观察没有冻结的被评审产物版本。')
  if (!view.candidates.some((item) => item.version)) view.status = 'unknown'
  return view
}
