import { access } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import type { AgentNodeDef, EventPayloads, NodeContext, NodeState, SandboxProvider, SandboxMount, TaktConfig } from '../types.js'
import { BlockedError, type HarnessHost } from './harness.js'
import { WriteGuard } from './guard.js'
import { sha256 } from '../util/hash.js'

// 执行面由独立包提供；延迟加载避免 core 初始化时反向加载依赖 core 的适配器。
interface ExecutionAdapters {
  createRepoManager(options: { projectDir: string; taktDir: string; repos: NonNullable<TaktConfig['repos']> }): import('../interfaces.js').RepoManager
  selectSandboxProvider(config: TaktConfig['sandbox']): Promise<SandboxProvider>
  syncSkills(options: { skillsDir: string; targetRoot: string; harness: string }): Promise<unknown>
}
let adapters: Promise<ExecutionAdapters> | undefined
export function executionAdapters(): Promise<ExecutionAdapters> {
  const name = '@taktflow/sandbox'
  return adapters ??= import(name) as Promise<ExecutionAdapters>
}
export const safeNodeName = (id: string): string => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)
  ? id : `${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${sha256(id).slice(0, 16)}`
export const diffPath = (id: string): string => `tasks/${safeNodeName(id)}.diff`

export async function workingDirectory(host: HarnessHost, node: AgentNodeDef, ctx: NodeContext, ns: NodeState): Promise<string> {
  if (!node.repo) return ctx.projectDir
  const repos = host.deps.repos
  if (!repos) throw new Error(`节点 ${node.id} 使用仓库 ${node.repo}，但未接入 RepoManager`)
  if (!ns.worktree) {
    const events = await host.deps.stores.events.read(ctx.runId, { nodeId: node.id, types: ['worktree.created'] })
    const previous = host.state.nodes[node.id]?.worktree ?? events.map((event) => event.data as EventPayloads['worktree.created']).filter((tree) => tree.repo === node.repo).at(-1)
    if (previous?.repo === node.repo) { ns.worktree = previous; host.state.nodes[node.id]!.worktree = previous; await host.save(); return previous.path }
    const tree = await host.guard.system(['.takt/worktrees/**'], () => repos.createWorktree({ repoId: node.repo!, runId: ctx.runId, nodeId: node.id }))
      .catch((error: unknown) => { throw new BlockedError(`worktree 引导失败：${error instanceof Error ? error.message : String(error)}`) })
    if (tree.bootstrap) {
      await host.emit('worktree.bootstrapped', { ...tree.bootstrap, repo: node.repo, path: tree.path }, node.id)
      if (!tree.bootstrap.ok) throw new BlockedError(`worktree 引导失败：${tree.bootstrap.output ?? node.repo}`)
    }
    ns.worktree = { ...tree, repo: node.repo }
    // review 的临时会话也必须把工作树身份落到真实节点状态。
    host.state.nodes[node.id]!.worktree = ns.worktree
    await host.emit('worktree.created', ns.worktree, node.id)
  }
  return ns.worktree.path
}

export async function saveWorktreeDiff(host: HarnessHost, nodeId: string, ns: NodeState, base?: string): Promise<void> {
  if (!ns.worktree) return
  const { stores, repos } = host.deps
  const diff = await repos!.diff(ns.worktree.path, base ?? ns.worktree.base)
  const patch = diff.patch.split(/(?=^diff --git )/m).filter((chunk) => !/^diff --git "?a\/\.(agents|claude)\/skills\//.test(chunk)).join('')
  const path = diffPath(nodeId)
  const prefix = relative(stores.projectDir, stores.workspaces.dir(host.state.requirementId))
  await host.guard.system([`${prefix}/${path}`], async () => {
    const ref = await stores.workspaces.writeArtifact({ ref: { workspace: host.state.requirementId, path }, content: patch,
      kind: 'code-change', author: { type: 'system', id: 'engine' }, reason: `仓库 ${ns.worktree!.repo} 节点 ${nodeId} 的改动`,
      producedBy: { runId: host.state.runId, nodeId }, derivedFrom: ns.inputs })
    const actual = host.state.nodes[nodeId]!
    actual.outputs = [...actual.outputs.filter((output) => output.path !== path), ref]
    ns.outputs = actual.outputs
    await host.emit('artifact.written', { ref, kind: 'code-change', sha256: sha256(patch) }, nodeId)
  })
}

export async function sandboxCall(host: HarnessHost, cwd: string, harness: string, ctx: NodeContext, env: Record<string, string>, timeoutMs?: number, directories: string[] = []) {
  const { stores } = host.deps
  const adapters = await executionAdapters()
  if (host.deps.skillsDir) await host.guard.system(['.agents/skills/**', '.claude/skills/**', '.takt/worktrees/**'],
    () => adapters.syncSkills({ skillsDir: host.deps.skillsDir!, targetRoot: cwd, harness }))
  const provider = host.deps.sandbox ?? await adapters.selectSandboxProvider(stores.config.sandbox)
  const mounts: SandboxMount[] = [{ source: cwd, target: cwd, mode: 'rw' as const }, { source: ctx.workspaceDir, target: ctx.workspaceDir, mode: 'rw' as const }]
  for (const path of directories) if (path !== cwd) mounts.push({ source: path, target: path, mode: 'rw' })
  if (env.TAKT_TRANSCRIPT) mounts.push({ source: dirname(env.TAKT_TRANSCRIPT), target: dirname(env.TAKT_TRANSCRIPT), mode: 'rw' })
  for (const source of [host.deps.skillsDir ?? stores.paths.skills, stores.paths.knowledge]) {
    try { await access(source) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    mounts.push({ source, target: source, mode: 'ro' })
  }
  return provider.create({ workdir: cwd, mounts, env, network: stores.config.sandbox?.network, image: stores.config.sandbox?.image,
    limits: timeoutMs ? { timeoutMs } : undefined })
}

export function cwdGuard(host: HarnessHost, cwd: string): WriteGuard {
  return cwd === host.deps.stores.projectDir ? host.guard : new WriteGuard(cwd)
}
