import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openProject, type NodeContext, type NodeResult } from '@taktflow/core'
import { createRepoManager } from '@taktflow/sandbox'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const execute = promisify(execFile)
const git = async (cwd: string, args: string[], signal?: AbortSignal) => (await execute('git', args, { cwd, signal, maxBuffer: 32 * 1024 * 1024 })).stdout.trim()
interface IntegrationTree { path: string; branch: string; merged: string[]; conflicts: string[] }
interface IntegrationResult extends IntegrationTree { repo: string; repositories: Record<string, IntegrationTree> }

export async function integrate(ctx: NodeContext): Promise<NodeResult> {
  const stores = await openProject(ctx.projectDir)
  const state = (await stores.runs.get(ctx.runId))!
  const primary = String(ctx.args.repo ?? 'app')
  const manager = createRepoManager({ projectDir: stores.projectDir, taktDir: stores.taktDir, repos: stores.config.repos ?? [] })
  const previous = ctx.resultOf('integration') as IntegrationResult | undefined
  const sources = Object.values(state.nodes).filter((node) => node.worktree && node.status === 'succeeded')
  const repos = [...new Set([primary, ...sources.map((node) => node.worktree!.repo)])]
  const repositories: Record<string, IntegrationTree> = Object.create(null)
  let failure: string | undefined
  for (const repo of repos) {
    const existing = previous?.repositories?.[repo] ?? (repo === primary ? previous : undefined)
    const tree = existing?.path ? { path: existing.path, branch: existing.branch }
      : await manager.createWorktree({ repoId: repo, runId: ctx.runId, nodeId: repo === primary ? 'integration' : `integration-${repo}` })
    const branch = `takt/${ctx.runId}/integration`
    // 每个仓库拥有独立的分支命名空间；工作树目录仍须在空间内唯一。
    if (tree.branch !== branch) await git(tree.path, ['branch', '-m', branch], ctx.signal)
    const result: IntegrationTree = { path: tree.path, branch, merged: [], conflicts: [] }
    repositories[repo] = result
    for (const node of sources.filter((node) => node.worktree!.repo === repo)) {
      const source = node.worktree!
      const diff = await manager.diff(source.path, source.base)
      const files = diff.files.filter((file) => !/^\.(agents|claude)\/skills\//.test(file))
      if (files.length) {
        await git(source.path, ['add', '--', ...files], ctx.signal)
        if (await git(source.path, ['diff', '--cached', '--name-only'], ctx.signal)) {
          await git(source.path, ['-c', 'user.name=Taktflow', '-c', 'user.email=taktflow@localhost', 'commit', '-m', `任务 ${node.id}`], ctx.signal)
        }
      }
      try {
        await git(tree.path, ['-c', 'user.name=Taktflow', '-c', 'user.email=taktflow@localhost', 'merge', '--no-edit', '--no-ff', source.branch], ctx.signal)
        result.merged.push(source.branch)
      } catch (error) {
        result.conflicts = (await git(tree.path, ['diff', '--name-only', '--diff-filter=U'], ctx.signal)).split('\n').filter(Boolean)
        failure = result.conflicts.length ? `仓库 ${repo} 集成冲突：${result.conflicts.join(', ')}` : `合并 ${source.branch} 失败：${(error as Error).message}`
        if (result.conflicts.length) await git(tree.path, ['merge', '--abort'])
        break
      }
    }
    if (failure) break
  }
  const main = repositories[primary]!
  const data: IntegrationResult = { repo: primary, path: main.path, branch: main.branch, repositories,
    merged: Object.values(repositories).flatMap((tree) => tree.merged),
    conflicts: Object.entries(repositories).flatMap(([repo, tree]) => tree.conflicts.map((file) => repos.length === 1 ? file : `${repo}/${file}`)) }
  const content = JSON.stringify({ ...data, error: failure }, null, 2)
  await mkdir(join(ctx.workspaceDir, 'tasks'), { recursive: true })
  await writeFile(join(ctx.workspaceDir, 'tasks/integration.json'), content)
  if (failure) await stores.workspaces.writeArtifact({ ref: { workspace: ctx.requirementId, path: 'tasks/integration.json' }, content,
    kind: 'code-change', author: { type: 'system', id: 'integration' }, reason: failure, producedBy: { runId: ctx.runId, nodeId: ctx.nodeId } })
  return { status: failure ? 'failed' : 'succeeded', message: failure, data }
}
