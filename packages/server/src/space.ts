import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spaceLock } from './space-lock.js'
import { randomUUID } from 'node:crypto'
import { FsEventStore, listSkills, loadProfiles, openProject, type Actor, type ProjectStores, type RepoBinding, type SpaceDetail, type SpaceFile, type SpaceMember, type SpaceSummary, type TaktConfig } from '@taktflow/core'
import { createRepoManager } from '@taktflow/sandbox'
import { createWorkflowStore } from '@taktflow/workflow-source'
import { ApiError as HttpError } from './errors.js'
import { safeId, text } from './validation.js'

const execute = promisify(execFile)

export async function discoverSpaces(dir: string): Promise<ProjectStores[]> {
  const spaces: ProjectStores[] = []
  for (const entry of (await readdir(resolve(dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const root = resolve(dir, entry.name)
    try { await access(join(root, 'takt.config.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    spaces.push(await openProject(root))
  }
  if (!spaces.length) throw new Error(`目录下没有项目空间：${dir}`)
  const ids = spaces.map(spaceId)
  if (new Set(ids).size !== ids.length) throw new Error('空间 ID 重复')
  return spaces
}
export const spaceId = (stores: ProjectStores): string => safeId(stores.config.space?.id ?? basename(stores.projectDir))
export function workflowStore(stores: ProjectStores) {
  return createWorkflowStore({ dir: stores.paths.workflows, historyDir: join(stores.taktDir, 'workflow-revisions'), gitCommit: false })
}
export const repoManager = (stores: ProjectStores) => createRepoManager({ projectDir: stores.projectDir, taktDir: stores.taktDir, repos: stores.config.repos ?? [] })
export async function spaceSummary(stores: ProjectStores): Promise<SpaceSummary> {
  const requirements = await stores.workspaces.listRequirements()
  return { id: spaceId(stores), ...stores.config.project, requirements: requirements.length, active: requirements.filter((req) => req.status === 'active').length }
}
export async function spaceDetail(stores: ProjectStores, workflows = () => workflowStore(stores).list()): Promise<SpaceDetail> {
  const profiles = await loadProfiles(stores.paths)
  const repos = await Promise.all((stores.config.repos ?? []).map(async (repo) => {
    const path = repo.url ? join(stores.taktDir, 'repos', repo.id) : resolve(stores.projectDir, repo.path)
    const ready = await access(path).then(() => true, () => false)
    if (!ready) return { ...repo, status: 'missing' as const }
    try {
      const ref = `${repo.url ? 'refs/remotes/origin/' : 'refs/heads/'}${repo.defaultBranch}^{commit}`
      const { stdout } = await execute('git', ['rev-parse', '--verify', '--end-of-options', ref], { cwd: path })
      return { ...repo, status: 'ready' as const, head: stdout.trim() }
    } catch { return { ...repo, status: 'error' as const, message: '仓库或默认分支不可读取，请同步仓库' } }
  }))
  const runs = await stores.runs.list()
  return { ...await spaceSummary(stores), members: stores.config.members ?? [], repos, skills: await listSkills(stores.paths.skills),
    agents: Object.values(profiles).map(({ role, title, description, harness, writeScope }) => ({ role, title, description, harness, writeScope })),
    workflows: (await workflows()).map((item) => ({ ...item, runs: runs.filter((run) => run.workflowId === item.id).length })),
    knowledge: (stores.config.knowledge ?? []).map(({ id, kind }) => ({ id, kind, description: '' })) }
}

// EventStore 尚无自定义文件路径；在临时目录复用它的 append/verify，再原子替换空间日志。
export async function auditSpace(stores: ProjectStores, author: Actor, reason: string, message: string): Promise<void> {
  text(reason, 'reason')
  const file = join(stores.taktDir, 'space-events.jsonl')
  const anchor = join(stores.taktDir, 'space-chain.json')
  await spaceLock(file, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'takt-space-audit-'))
    try {
      const target = join(scratch, 'runs/space/events.jsonl')
      await mkdir(dirname(target), { recursive: true })
      try { await copyFile(file, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const targetAnchor = join(scratch, 'runs/space/chain.json')
      try { await copyFile(anchor, targetAnchor) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const events = new FsEventStore(scratch)
      if (!(await events.verify('space')).ok) throw new Error('空间审计链已损坏，拒绝写入')
      await events.append('space', { type: 'log', actor: author, data: { level: 'info', message: JSON.stringify({ message, reason }) } })
      await atomicWrite(file, await readFile(target))
      await atomicWrite(anchor, await readFile(targetAnchor))
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
}
export async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temp, content, { flag: 'wx' }); await rename(temp, file) }
  finally { await rm(temp, { force: true }) }
}
export async function changeConfig(stores: ProjectStores, author: Actor, reason: string, message: string, change: (config: TaktConfig) => void): Promise<void> {
  text(reason, 'reason')
  const file = join(stores.projectDir, 'takt.config.json')
  await spaceLock(file, async () => {
    const config = (await openProject(stores.projectDir)).config
    change(config)
    await auditSpace(stores, author, reason, message)
    await atomicWrite(file, JSON.stringify(config, null, 2) + '\n')
    stores.config = config
  })
}
export function members(value: unknown): SpaceMember[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'members 必须是数组')
  const result = value.map((member: Record<string, unknown>) => {
    if (!member || typeof member !== 'object' || !['owner', 'maintainer', 'member', 'viewer'].includes(String(member.role))) throw new HttpError(400, '成员角色不合法')
    return { id: safeId(text(member.id, 'id')), name: text(member.name, 'name'), role: member.role as SpaceMember['role'],
      ...(member.duties === undefined ? {} : { duties: stringList(member.duties, 'duties') }),
      ...(member.email === undefined ? {} : { email: text(member.email, 'email') }) }
  })
  if (new Set(result.map((member) => member.id)).size !== result.length) throw new HttpError(400, '成员 ID 重复')
  return result
}
export function repoBinding(value: Record<string, unknown>): RepoBinding {
  const id = text(value.id, 'id')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new HttpError(400, 'repo id 不合法')
  const repo: RepoBinding = { id, path: text(value.path, 'path'), defaultBranch: text(value.defaultBranch, 'defaultBranch') }
  if (repo.defaultBranch.startsWith('-') || /[\s~^:?*\[\\]/.test(repo.defaultBranch) || repo.defaultBranch.includes('..')) throw new HttpError(400, 'defaultBranch 不合法')
  for (const key of ['url', 'purpose', 'description', 'bootstrap'] as const) if (value[key] !== undefined) repo[key] = text(value[key], key)
  if (value.share !== undefined) {
    repo.share = stringList(value.share, 'share')
    if (repo.share.some((path) => path.startsWith('/') || path.includes('\\') || path.split('/').includes('..'))) throw new HttpError(400, 'share 必须是仓库内相对路径')
  }
  return repo
}
export async function spaceFile(stores: ProjectStores, kind: string | null, name: string | null): Promise<SpaceFile> {
  if (kind !== 'skill' && kind !== 'agent') throw new HttpError(400, 'kind 必须是 skill 或 agent')
  const key = safeId(text(name, 'name'))
  const root = kind === 'skill' ? stores.paths.skills : stores.paths.agents
  const file = kind === 'skill' ? join(root, key, 'SKILL.md') : join(root, key.endsWith('.md') ? key : `${key}.md`)
  // 逐段拒绝符号链接，防止在线编辑逃出空间资产目录。
  const full = resolve(file)
  const ancestors: string[] = []
  const project = resolve(stores.projectDir)
  const boundary = relative(project, full).startsWith('..') ? resolve(root) : project
  for (let current = full; current !== boundary && dirname(current) !== current; current = dirname(current)) ancestors.push(current)
  for (const part of ancestors) {
    try { if ((await lstat(part)).isSymbolicLink()) throw new HttpError(400, '资产路径不能包含符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  let content = ''
  try { content = await readFile(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { kind, name: key, path: relative(stores.projectDir, file), content }
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new HttpError(400, `${name} 必须是非空字符串数组`)
  return value
}
