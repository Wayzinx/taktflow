import type { ArtifactRef, NodeContext, ReviewNodeDef } from '../../types.js'
import type { Runtime } from '../runtime.js'
import { resolveInputs } from '../artifacts.js'
import { matchGlob } from '../../util/glob.js'

/** M2-B 可在此替换为 worktree diff；当前只接收本运行、对应仓库登记的任务 diff。 */
export async function codeReviewTargets(host: Runtime, node: ReviewNodeDef, ctx: NodeContext): Promise<string[]> {
  if (Array.isArray(node.target)) return node.target
  const repo = node.target.code.repo
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
