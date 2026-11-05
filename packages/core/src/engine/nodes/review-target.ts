import type { ArtifactRef, NodeContext, ReviewNodeDef } from '../../types.js'
import type { Runtime } from '../runtime.js'
import { resolveInputs } from '../artifacts.js'
import { diffPath, saveWorktreeDiff } from '../execution.js'
import { matchGlob } from '../../util/glob.js'

/** 有执行面时从本运行的工作树读取；旧运行保留其已登记 diff 的读取能力。 */
export async function codeReviewTargets(host: Runtime, node: ReviewNodeDef, ctx: NodeContext): Promise<string[]> {
  if (Array.isArray(node.target)) return node.target
  const repo = node.target.code.repo
  const sources = Object.values(host.state.nodes).filter((state) => state.worktree?.repo === repo
    && (!ctx.item || host.graph.get(state.id)?.item?.key === ctx.item.key))
  if (sources.length) {
    for (const state of sources) await saveWorktreeDiff(host, state.id, state, Array.isArray(node.target) ? undefined : node.target.code.base)
    return sources.map((state) => diffPath(state.id))
  }
  if (host.deps.repos) throw new Error(`评审 ${node.id} 没有仓库 ${repo} 的任务工作树`)
  const artifacts = await host.deps.stores.workspaces.listArtifacts(ctx.requirementId)
  return artifacts.filter((artifact) => {
    if (!matchGlob('tasks/*.diff', artifact.path)) return false
    if (ctx.item && artifact.path !== `tasks/${ctx.item.key}.diff`) return false
    const latest = artifact.versions.at(-1)!
    const producers = Object.values(host.state.nodes).filter((state) => state.outputs.some((ref) =>
      ref.path === artifact.path && ref.version === latest.version)).map((state) => state.id)
    if (latest.producedBy?.runId === ctx.runId) producers.push(latest.producedBy.nodeId)
    return producers.some((id) => {
      const entry = host.graph.get(id)
      const def = entry?.def
      const producerRepo = def?.kind === 'agent' ? def.repo
        : def?.kind === 'review' && !Array.isArray(def.target) ? def.target.code.repo : undefined
      // 未接 worktree 的脚本/任务通过 item.params.repo 或唯一绑定仓库明确归属。
      const binding = producerRepo ?? entry?.item?.params?.repo
        ?? (host.deps.stores.config.repos?.length === 1 ? host.deps.stores.config.repos[0]!.id : undefined)
      return binding === repo
    })
  }).map((artifact) => artifact.path)
}

export async function reviewTargets(host: Runtime, node: ReviewNodeDef, ctx: NodeContext): Promise<ArtifactRef[]> {
  const paths = Array.isArray(node.target) ? node.target : await codeReviewTargets(host, node, ctx)
  if (!paths.length) throw new Error(`评审 ${node.id} 没有可评审产物`)
  return host.guard.system(host.workspacePaths(paths), () => resolveInputs(host.deps.stores, host.state,
    { ...node, inputs: paths.map((path) => ({ path })) }, host.emit))
}
