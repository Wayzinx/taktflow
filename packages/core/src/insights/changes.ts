import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { ProjectStores, RepoManager } from '../interfaces.js'
import type { EventPayloads, NodeDef, NodeState, RewindPoint, RunState } from '../types.js'
import type { NodeChanges } from '../api.js'
import { assertArtifactPath, assertNodeId, runDir } from '../store/paths.js'
import { assertNoSymlinks, readFileIfExists, readJsonFile, writeFileAtomic } from '../store/fs-utils.js'
import { matchGlob } from '../util/glob.js'
import { sha256 } from '../util/hash.js'
import { executionAdapters, safeNodeName } from '../engine/execution.js'

const exec = promisify(execFile)
export async function rewindGit(path: string, args: string[]): Promise<string> {
  try { return (await exec('git', ['--literal-pathspecs', '-C', path, ...args], { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout }
  catch (cause) { throw new Error('无法读取或恢复工作树，请检查仓库路径与 Git 状态后重试', { cause }) }
}
export interface ChangeCapture { attempt: number; point: RewindPoint; dirtyAtStart?: boolean; end?: { files: NodeChanges['files']; repos: Array<{ path: string; head: string; hash: string }>; patches?: Array<{ repo: string; path: string; patch: string }> } }
export const changesFile = (stores: ProjectStores, runId: string, nodeId: string) => join(runDir(stores.taktDir, runId), 'changes', `${safeNodeName(assertNodeId(nodeId))}.json`)
export async function repoManager(stores: ProjectStores): Promise<RepoManager> {
  return (await executionAdapters()).createRepoManager({ projectDir: stores.projectDir, taktDir: stores.taktDir, repos: stores.config.repos ?? [] })
}
export async function captureRewindPoint(stores: ProjectStores, state: RunState, node: NodeDef, ns: NodeState): Promise<RewindPoint> {
  const artifacts = await stores.workspaces.listArtifacts(state.requirementId)
  const point: RewindPoint = { at: new Date().toISOString(), artifacts: artifacts.filter(artifact => node.outputs?.some(output => matchGlob(output.path, artifact.path)))
    .flatMap(artifact => artifact.versions.at(-1) ? [{ workspace: state.requirementId, path: artifact.path, version: artifact.versions.at(-1)!.version }] : []) }
  let dirtyAtStart = false
  if (ns.worktree) {
    point.repos = [{ repo: ns.worktree.repo, path: ns.worktree.path, head: (await rewindGit(ns.worktree.path, ['rev-parse', 'HEAD'])).trim() }]
    dirtyAtStart = Boolean((await rewindGit(ns.worktree.path, ['status', '--porcelain', '--untracked-files=all'])).trim())
  }
  await writeFileAtomic(changesFile(stores, state.runId, node.id), JSON.stringify({ attempt: ns.attempts, point, dirtyAtStart } satisfies ChangeCapture))
  return point
}
function counts(before: string, after: string): { add: number; del: number } {
  const a = before ? before.match(/[^\n]*\n|[^\n]+$/g)! : [], b = after ? after.match(/[^\n]*\n|[^\n]+$/g)! : []
  // Myers 最短编辑路径：分散修改之间的未变行不算新增/删除。
  const frontier = new Map<number, number>([[1, 0]])
  for (let distance = 0; distance <= a.length + b.length; distance++) {
    for (let k = -distance; k <= distance; k += 2) {
      let x = k === -distance || k !== distance && (frontier.get(k - 1) ?? -Infinity) < (frontier.get(k + 1) ?? -Infinity)
        ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++ }
      frontier.set(k, x)
      if (x >= a.length && y >= b.length) return { add: (distance + b.length - a.length) / 2, del: (distance + a.length - b.length) / 2 }
    }
  }
  throw new Error('无法计算文件改动，请检查产物内容后重试')
}

async function workspaceChanges(stores: ProjectStores, state: RunState, nodeId: string, point: RewindPoint): Promise<NodeChanges['files']> {
  const events = await stores.events.read(state.runId, { nodeId })
  const start = events.map(event => event.type).lastIndexOf('node.started')
  const writes = new Map(events.slice(start + 1).filter(event => event.type === 'artifact.written')
    .map(event => { const ref = (event.data as EventPayloads['artifact.written']).ref; return [ref.path, ref] }))
  const files: NodeChanges['files'] = []
  for (const ref of writes.values()) {
    assertArtifactPath(ref.path)
    const previous = point.artifacts?.find(item => item.workspace === ref.workspace && item.path === ref.path)
    const before = previous ? await stores.workspaces.readArtifact(previous) : undefined
    const after = await stores.workspaces.readArtifact(ref)
    if (previous?.version === ref.version) continue
    files.push({ scope: 'workspace', path: ref.path, status: previous ? 'modified' : 'added', from: previous?.version, to: ref.version,
      ...counts(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '') })
  }
  return files
}
export async function repoChanges(stores: ProjectStores, point: RewindPoint, manager?: RepoManager): Promise<{ files: NodeChanges['files']; repos: NonNullable<ChangeCapture['end']>['repos'] }> {
  const files: NodeChanges['files'] = [], repos: NonNullable<ChangeCapture['end']>['repos'] = []
  for (const repo of point.repos ?? []) {
    if (!/^[a-f0-9]{40,64}$/i.test(repo.head)) throw new Error('回退点提交不合法，请重新运行节点')
    const diff = await (manager ?? await repoManager(stores)).diff(repo.path, repo.head)
    repos.push({ path: repo.path, head: (await rewindGit(repo.path, ['rev-parse', 'HEAD'])).trim(), hash: sha256(diff.patch + await rewindGit(repo.path, ['status', '--porcelain=v1', '-z'])) })
    const status = (await rewindGit(repo.path, ['diff', '--name-status', '-z', '-M', repo.head, '--'])).split('\0')
    const rows = new Map<string, { status: NodeChanges['files'][number]['status']; oldPath?: string }>()
    for (let i = 0; i < status.length - 1;) {
      const kind = status[i++]!, path = status[i++]!
      if (kind.startsWith('R')) rows.set(status[i++]!, { status: 'renamed', oldPath: path })
      else rows.set(path, { status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified' })
    }
    for (const path of diff.files) {
      assertArtifactPath(path)
      const row = rows.get(path) ?? { status: 'added' as const }
      if (row.oldPath) assertArtifactPath(row.oldPath)
      const stat = await rewindGit(repo.path, ['diff', '--numstat', '-M', repo.head, '--', ...(row.oldPath ? [row.oldPath] : []), path])
      const [add, del] = stat.split('\t')
      let added = Number(add) || 0
      if (row.status === 'added' && !stat) {
        await assertNoSymlinks(repo.path, join(repo.path, path))
        added = counts('', (await readFileIfExists(join(repo.path, path)))?.toString('utf8') ?? '').add
      }
      files.push({ scope: 'repo', repo: repo.repo, path, ...row, add: added, del: Number(del) || 0 })
    }
  }
  return { files, repos }
}
export async function captureNodeChanges(stores: ProjectStores, state: RunState, nodeId: string, manager?: RepoManager): Promise<void> {
  const file = changesFile(stores, state.runId, nodeId), capture = await readJsonFile<ChangeCapture>(file)
  if (!capture || capture.attempt !== state.nodes[nodeId]?.attempts) return
  const repo = await repoChanges(stores, capture.point, manager)
  const patches: NonNullable<NonNullable<ChangeCapture['end']>['patches']> = []
  if (!capture.dirtyAtStart) for (const file of repo.files) {
    const tree = capture.point.repos!.find(tree => tree.repo === file.repo)!
    // 冻结逐文件 diff，之后查看改动不能混入外部编辑。
    let patch: string
    if (file.status === 'added') {
      await assertNoSymlinks(tree.path, join(tree.path, file.path))
      const { proposalDiff } = await import('../steward/diff.js')
      patch = await proposalDiff(file.path, '', (await readFileIfExists(join(tree.path, file.path)))?.toString('utf8') ?? '')
    } else patch = await rewindGit(tree.path, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '-M', tree.head, '--', ...(file.oldPath ? [file.oldPath] : []), file.path])
    patches.push({ repo: file.repo!, path: file.path, patch })
  }
  capture.end = { ...repo, patches, files: [...(capture.dirtyAtStart ? [] : repo.files), ...await workspaceChanges(stores, state, nodeId, capture.point)] }
  await writeFileAtomic(file, JSON.stringify(capture))
}
export async function nodeChanges(stores: ProjectStores, runId: string, nodeId: string): Promise<NodeChanges> {
  assertNodeId(nodeId)
  const state = await stores.runs.get(runId)
  if (!state?.nodes[nodeId]) throw new Error('节点不存在，请刷新运行后重试')
  const capture = await readJsonFile<ChangeCapture>(changesFile(stores, runId, nodeId))
  const events = await stores.events.read(runId, { nodeId, types: ['node.started'] })
  const point = (events.at(-1)?.data as EventPayloads['node.started'] | undefined)?.rewindPoint
  if (!point) return { files: [], add: 0, del: 0, rewindBlocked: '旧运行没有回退点，请重新运行节点' }
  const valid = capture?.attempt === state.nodes[nodeId]!.attempts ? capture : undefined
  const current = await repoChanges(stores, point)
  const files = valid?.end?.files ?? [...(valid?.dirtyAtStart ? [] : current.files), ...await workspaceChanges(stores, state, nodeId, point)]
  let blocked = valid?.dirtyAtStart ? '节点开始前工作树已有外部改动，无法可靠归因仓库差异；请人工处理后重跑' : undefined
  if (!valid?.end && state.nodes[nodeId]!.status !== 'running') blocked = '缺少节点结束时的改动记录，请重新运行节点'
  if (valid?.end && JSON.stringify(current.repos) !== JSON.stringify(valid.end.repos)) blocked = '工作树在节点结束后已改变，请检查外部改动后重新预览'
  const artifacts = await stores.workspaces.listArtifacts(state.requirementId)
  const untracked = await stores.workspaces.detectUntracked(state.requirementId)
  for (const file of files.filter(file => file.scope === 'workspace')) {
    await assertNoSymlinks(stores.workspaces.dir(state.requirementId), join(stores.workspaces.dir(state.requirementId), assertArtifactPath(file.path)))
    if (!await readFileIfExists(join(stores.workspaces.dir(state.requirementId), file.path))) blocked = '产物文件已被外部删除，请恢复文件后重新预览'
    if (artifacts.find(artifact => artifact.path === file.path)?.versions.at(-1)?.version !== file.to || untracked.some(item => item.path === file.path)) blocked = '产物在节点结束后已改变，请检查外部改动后重新预览'
  }
  if (state.nodes[nodeId]!.status === 'running') blocked = '节点正在运行，请等待结束后重新预览'
  return { files, add: files.reduce((n, file) => n + file.add, 0), del: files.reduce((n, file) => n + file.del, 0), rewindPoint: point, rewindBlocked: blocked }
}
