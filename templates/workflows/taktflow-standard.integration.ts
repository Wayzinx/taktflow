import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openProject, systemWrite, type NodeContext, type NodeResult } from '@taktflow/core'
import { createRepoManager } from '@taktflow/sandbox'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

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

/**
 * 准出后合进默认分支（docs/design/17 §代码仓库）：集成分支只在本地合，不推远程。
 * 默认分支正检出在仓库目录里就在那儿合（工作区随之更新）；检出的是别的分支就借一个临时 worktree 合。
 * 冲突、或会覆盖仓库目录里未提交的改动时中止合并，节点失败交人：手动合好后在运行页重试这个节点。
 */
export async function mergeToDefault(ctx: NodeContext): Promise<NodeResult> {
  const stores = await openProject(ctx.projectDir)
  const state = (await stores.runs.get(ctx.runId))!
  const branch = `takt/${ctx.runId}/integration`
  // 集成可能跑过几次（集成、集成修复）：取最后结束的那次结果
  const latest = Object.values(state.nodes)
    .filter((node) => (node.result as IntegrationResult | undefined)?.branch === branch && (node.result as IntegrationResult).repositories)
    .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? '')).at(-1)?.result as IntegrationResult | undefined
  if (!latest) return { status: 'failed', message: '没有找到集成结果，无法合入默认分支' }
  const merged: Array<{ repo: string; into: string; head: string }> = []
  for (const [repo, tree] of Object.entries(latest.repositories)) {
    const binding = stores.config.repos?.find((item) => item.id === repo)
    if (!binding) return { status: 'failed', message: `仓库 ${repo} 不在空间配置里，无法合入` }
    const dir = resolve(stores.projectDir, binding.path)
    const into = binding.defaultBranch
    if (await git(dir, ['merge-base', '--is-ancestor', tree.branch, into], ctx.signal).then(() => true, () => false)) continue
    const files = (await git(dir, ['diff', '--name-only', `${into}...${tree.branch}`], ctx.signal)).split('\n').filter(Boolean)
    const checkedOut = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.signal)) === into
    const target = checkedOut ? dir : join(stores.taktDir, 'worktrees', ctx.runId, `merge-${repo}`)
    const prefix = relative(stores.projectDir, dir)
    const watched = !prefix.startsWith('..') && !isAbsolute(prefix)
    const merge = async () => {
      if (!checkedOut) await git(dir, ['worktree', 'add', '--quiet', target, into], ctx.signal)
      try {
        await git(target, ['-c', 'user.name=Taktflow', '-c', 'user.email=taktflow@localhost', 'merge', '--no-ff', '--no-edit', '-m', `合入 ${ctx.requirementId}（${ctx.runId}）`, tree.branch], ctx.signal)
        return await git(target, ['rev-parse', 'HEAD'], ctx.signal)
      } catch (error) {
        const conflicts = (await git(target, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean)
        if (conflicts.length) await git(target, ['merge', '--abort']).catch(() => undefined)
        throw new Error(conflicts.length ? `合入 ${into} 冲突：${conflicts.join(', ')}` : `合入 ${into} 失败：${(error as Error).message.split('\n').find((line) => /error|fatal/i.test(line)) ?? (error as Error).message}`)
      } finally {
        if (!checkedOut) await git(dir, ['worktree', 'remove', '--force', target]).catch(() => undefined)
      }
    }
    try {
      // 合并改的是空间里的文件：记成系统写入，不算到同时在跑的 agent 头上
      const head = watched && checkedOut ? await systemWrite(stores.projectDir, files.map((file) => prefix ? `${prefix}/${file}` : file), merge) : await merge()
      merged.push({ repo, into, head })
    } catch (error) {
      return { status: 'failed', message: `${(error as Error).message}。手动合好后在运行页重试这个节点`, data: { merged } }
    }
  }
  return { status: 'succeeded', message: merged.length ? `已合进 ${[...new Set(merged.map((item) => item.into))].join('、')}` : '已在默认分支里，无需合入', data: { merged } }
}
