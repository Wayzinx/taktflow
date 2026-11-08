import { randomUUID } from 'node:crypto'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, Defect, DefectMergeSuggestion, Observation } from '../types.js'
import { sha256, canonicalJson } from '../util/hash.js'
import { qualityRequirement, readQualityDefect, requireHuman, requireReason, requireRevision } from './quality-service.js'

function similar(left: string, right: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
  const a = normalize(left), b = normalize(right)
  if (a === b && a.length > 0) return true
  if (a.length < 4 || b.length < 4) return false
  const pairs = (text: string) => new Set(Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)))
  const x = pairs(a), y = pairs(b)
  return 2 * [...x].filter(value => y.has(value)).length / (x.size + y.size) >= 0.8
}
function mergeReason(left: Defect, right: Defect, observations: Observation[]): string | undefined {
  const source = (defect: Defect) => observations.filter(item => defect.observations?.includes(item.id))
  for (const a of source(left)) for (const b of source(right)) {
    if (a.checkpointId && a.checkpointId === b.checkpointId && a.runId === b.runId) return '来自同一检查点，建议人工核对是否同一根因'
    // ISS-n 只在同一运行、同一评审节点内唯一；用例 id 不是问题身份。
    if (a.source === 'review' && b.source === 'review' && a.runId && a.nodeId && a.runId === b.runId && a.nodeId === b.nodeId
      && /^ISS-\d+$/.test(a.subject ?? '') && a.subject === b.subject) return '来自同一系统问题键，建议人工核对是否重复'
  }
  return similar(left.title, right.title) ? '标题相近，建议人工核对是否同一根因' : undefined
}

export async function suggestDefectMerges(stores: ProjectStores, req: string, by: Actor, reason: string): Promise<DefectMergeSuggestion[]> {
  requireReason(reason)
  const quality = await qualityRequirement(stores, req)
  const defects = await quality.defects(req), observations = await quality.observations({ requirementId: req })
  for (let i = 0; i < defects.length; i++) for (const right of defects.slice(i + 1)) {
    const left = defects[i]!, hint = mergeReason(left, right, observations)
    if (!hint) continue
    const ids = [left.id, right.id].sort(), id = `merge-${sha256(canonicalJson([req, ids])).slice(0, 24)}`
    const suggestion: DefectMergeSuggestion = { id, defects: ids, reason: `${reason.trim()}：${hint}`, status: 'suggested', at: new Date().toISOString() }
    await quality.append([{ kind: 'merge.suggested', key: `merge:suggest:${req}:${id}`, requirementId: req, data: suggestion, actor: by }],
      { baseRevision: { defectId: left.id, revision: left.revision! } })
  }
  return quality.mergeSuggestions(req)
}

export async function decideDefectMerge(stores: ProjectStores, req: string, suggestionId: string,
  request: { action: 'accept' | 'reject' | 'undo'; baseRevision: number; reason: string }, by: Actor): Promise<DefectMergeSuggestion> {
  requireHuman(by); requireRevision(request.baseRevision)
  const reason = requireReason(request.reason), quality = await qualityRequirement(stores, req)
  const suggestion = (await quality.mergeSuggestions(req)).find(item => item.id === suggestionId)
  if (!suggestion) throw new Error('合并建议不存在；请刷新建议列表')
  const status = { accept: 'accepted', reject: 'rejected', undo: 'undone' } as const
  if (!Object.hasOwn(status, request.action) || (request.action === 'undo'
    ? !['accepted', 'rejected'].includes(suggestion.status) : !['suggested', 'undone'].includes(suggestion.status))) {
    throw new Error('合并建议状态已改变或动作不合法；请刷新后重试')
  }
  const primary = suggestion.defects[0]!
  await readQualityDefect(stores, req, primary)
  const token = randomUUID()
  // 合并是可撤销的人工分组，不删除观察或缺陷；同步推进关联缺陷版本以串行化决定。
  await quality.append([
    { kind: 'merge.decided', key: `merge:decide:${token}`, requirementId: req, data: { id: suggestionId, status: status[request.action], decidedBy: by, at: new Date().toISOString(), reason }, actor: by },
    { kind: 'defect.updated', key: `merge:revision:${token}`, requirementId: req, data: { id: primary, reason }, actor: by },
  ], { baseRevision: { defectId: primary, revision: request.baseRevision } })
  return (await quality.mergeSuggestions(req)).find(item => item.id === suggestionId)!
}
