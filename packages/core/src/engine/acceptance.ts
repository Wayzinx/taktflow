import type { ArtifactRef, GateCheckResult } from '../types.js'
import { readArtifactData } from '../insights/artifacts.js'
import { buildTraceGraph } from '../insights/trace.js'
import type { Entry } from './graph.js'
import type { NodeHost } from './nodes/host.js'
import { RUBRIC_SCHEMA } from './nodes/schemas.js'

async function evaluateAcceptance(host: NodeHost, entry: Entry, id: string, role?: string): Promise<GateCheckResult> {
  const { workspaces } = host.deps.stores
  const requirementId = host.state.requirementId
  const data = await readArtifactData(workspaces, requirementId)
  const graph = buildTraceGraph(requirementId, requirementId, data)
  const details = await Promise.all([...data.acs].map(async ([ac, title]) => {
    const caseIds = graph.edges.filter((edge) => edge.rel === 'covers' && edge.to === ac).map((edge) => edge.from)
    const cases = await Promise.all(caseIds.map(async (caseId) => {
      const evidence = graph.edges.filter((edge) => edge.rel === 'verifies' && edge.to === caseId)
        .map((edge) => graph.nodes.find((node) => node.id === edge.from)?.ref)
        .filter((ref): ref is ArtifactRef => ref !== undefined && ref.path !== 'evidence/summary.json')
      const readable = await Promise.all(evidence.map(async (ref) => !!(await workspaces.readArtifact(ref))?.toString().trim()))
      return { id: caseId, status: data.results.get(caseId) ?? 'not_run', evidence: evidence.filter((_, index) => readable[index]),
        pass: data.results.get(caseId) === 'passed' && readable.some(Boolean) }
    }))
    return { ac, title, cases, pass: cases.length > 0 && cases.every((testCase) => testCase.pass) }
  }))
  const pass = details.length > 0 && details.every((item) => item.pass)
  if (!pass) return { id, pass: false, details, message: details.length ? '交付校验未通过：存在无用例、未通过或缺少证据的 AC' : '交付校验未通过：没有验收标准 AC' }
  if (!role) return { id, pass: true, details }
  const producers = new Set<string>()
  for (const artifact of data.artifacts.filter((artifact) => artifact.kind === 'case' || artifact.kind === 'code-change')) {
    for (const version of artifact.versions) {
      if (version.producedBy?.runId !== host.state.runId) continue
      const producer = host.graph.get(version.producedBy.nodeId)?.def
      if (producer?.kind === 'agent') producers.add(producer.role)
      if (version.author.type === 'agent') producers.add(version.author.role)
    }
  }
  if (producers.has(role)) return { id, pass: false, details, message: `交付校验角色 ${role} 与本运行的用例 / 代码产出角色相同` }
  const review = await host.model(entry, host.context(entry), role,
    `独立复核交付校验。逐条确认 AC 的用例、最近执行结果与证据，不得以作者自述作为通过依据。输出 score、pass、message。\n${JSON.stringify(details)}`, RUBRIC_SCHEMA) as GateCheckResult
  return { id, pass: review.pass === true, message: review.message, score: review.score, details }
}

export async function checkAcceptance(host: NodeHost, entry: Entry, id: string, role?: string): Promise<GateCheckResult> {
  try {
    const result = await evaluateAcceptance(host, entry, id, role)
    return { ...result, status: result.pass ? 'pass' : 'fail' }
  } catch (error) {
    return { id, pass: false, status: 'error', message: `交付校验执行失败：${error instanceof Error ? error.message : String(error)}；请修复材料或检查服务后重试` }
  }
}
