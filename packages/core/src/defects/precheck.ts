import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, Defect, DefectAttribution, EventPayloads } from '../types.js'
import { createInsights } from '../insights/fs-insights.js'
import { readArtifactData } from '../insights/artifacts.js'
import { snapshotNodes } from '../engine/recipe.js'

export type DefectPrecheck = DefectAttribution['precheck'] & {
  evidence: Array<{ caseId: string; status?: string; artifacts: ArtifactRef[] }>
  codeChanges: Array<{ file: string; nodeId: string; runId: string; commit: string }>
}
export async function precheckDefect(stores: ProjectStores, defect: Defect): Promise<DefectPrecheck> {
  const graph = await createInsights(stores).traceGraph(defect.requirementId)
  const data = await readArtifactData(stores.workspaces, defect.requirementId)
  const acs = defect.acs ?? []
  const cases = [...new Set(graph.edges.filter((edge) => edge.rel === 'covers' && acs.includes(edge.to)).map((edge) => edge.from))]
  const result: DefectPrecheck = { acCovered: acs.length ? acs.every((ac) => graph.edges.some((edge) => edge.rel === 'covers' && edge.to === ac)) : undefined,
    cases, codeNodes: [], reviewedBy: [], gates: [], evidence: [], codeChanges: [] }
  for (const caseId of cases) result.evidence.push({ caseId, status: data.results.get(caseId),
    artifacts: data.artifacts.filter((artifact) => artifact.kind === 'evidence' && (artifact.traceIds.includes(caseId) || artifact.path === 'evidence/summary.json' || artifact.path.startsWith(`evidence/${caseId}/`)))
      .map((artifact) => ({ workspace: defect.requirementId, path: artifact.path, version: artifact.versions.at(-1)?.version })) })
  const related = new Set(data.artifacts.filter((a) => a.traceIds.some((id) => [...acs, ...cases].includes(id))).map((a) => a.path))
  // 把溯源前驱与后继一起纳入，避免只检查直接引用 AC 的末端文件。
  let changed = true
  while (changed) {
    changed = false
    for (const artifact of data.artifacts) for (const version of artifact.versions) {
      if (related.has(artifact.path) || version.derivedFrom.some((ref) => ref.workspace === defect.requirementId && related.has(ref.path))) {
        for (const path of [artifact.path, ...version.derivedFrom.filter((ref) => ref.workspace === defect.requirementId).map((ref) => ref.path)]) {
          if (!related.has(path)) { related.add(path); changed = true }
        }
      }
    }
  }
  for (const run of await stores.runs.list({ requirementId: defect.requirementId })) {
    const snapshot = await stores.runs.getWorkflow(run.runId)
    const created = await stores.events.read(run.runId, { types: ['worktree.created'] })
    for (const node of snapshotNodes([...(snapshot?.nodes ?? []), ...run.expansions.flatMap((item) => item.nodes ?? [])])) {
      const state = run.nodes[node.id]
      if (!state || !state.attempts) continue
      const relevant = state.inputs?.some((ref) => related.has(ref.path)) || state.outputs.some((ref) => related.has(ref.path))
      if (relevant && node.kind === 'review') result.reviewedBy!.push(node.id)
      const dependencyRelevant = node.needs.some((need) => run.nodes[need]?.outputs.some((ref) => related.has(ref.path)))
      if (node.kind === 'gate' && (relevant || dependencyRelevant || node.checks?.some((check) => check.kind === 'acceptance'))) result.gates!.push(node.id)
      // Loop 下一轮跳过节点会清空当前工作树，从已记录事件恢复代码来源。
      const worktree = state.worktree ?? created.filter((event) => event.nodeId === node.id).at(-1)?.data as EventPayloads['worktree.created'] | undefined
      if (!worktree) continue
      try {
        const { stdout } = await promisify(execFile)('git', ['-C', worktree.path, 'log', '--format=%H', '--name-only', `${worktree.base}..${worktree.branch}`], { maxBuffer: 1024 * 1024 })
        let commit = ''
        for (const line of stdout.split('\n').filter(Boolean)) {
          if (/^[a-f0-9]{40,64}$/.test(line)) { commit = line; continue }
          if (commit && [defect.description, ...(defect.evidence ?? [])].some((text) => text.includes(line))) {
            result.codeChanges.push({ file: line, commit, nodeId: node.id, runId: run.runId }); result.codeNodes!.push(node.id)
          }
        }
      } catch { /* 工作树已清理或分支不可读时，不推测代码归属。 */ }
    }
  }
  result.codeNodes = [...new Set(result.codeNodes)]; result.reviewedBy = [...new Set(result.reviewedBy)]; result.gates = [...new Set(result.gates)]
  return result
}
