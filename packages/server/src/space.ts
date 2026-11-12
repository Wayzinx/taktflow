import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { bindCrudServices, systemWrite, type CommandHandlers, type EngineDeps, type TaktConfig as Config } from '@taktflow/core'
import { projectCommands as baseProjectCommands } from './commands.js'
import { convertWorkflow } from './workflow-routes.js'
import { spaceLock } from './space-lock.js'
import { randomUUID } from 'node:crypto'
import { FsEventStore, listSkills, loadProfiles, openProject, type Actor, type ProjectStores, type RepoBinding, type SpaceDetail, type SpaceFile, type SpaceMember, type SpaceSummary, type TaktConfig } from '@taktflow/core'
import { createRepoManager } from '@taktflow/sandbox'
import { createWorkflowStore, type WorkflowStore } from '@taktflow/workflow-source'
import { HttpError, safeId, text } from './http.js'

const execute = promisify(execFile)

export async function discoverSpaces(dir: string): Promise<ProjectStores[]> {
  const spaces: ProjectStores[] = []
  for (const entry of (await readdir(resolve(dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const root = resolve(dir, entry.name)
    try { await access(join(root, 'takt.config.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    try {
      const stores = await openProject(root)
      const id = spaceId(stores)
      if (spaces.some(space => spaceId(space) === id)) continue
      spaces.push(stores)
    } catch {
      // 一个空间损坏不能阻断其他空间；目录保持原样，修复配置后会重新发现。
      continue
    }
  }
  const ids = spaces.map(spaceId)
  if (new Set(ids).size !== ids.length) throw new Error('空间 ID 重复')
  return spaces
}
// 归档目录名带 @时间戳；没写 space.id 的老空间按原目录名算 ID，否则归档列表和恢复都会被这个 @ 挡住。
export const spaceId = (stores: ProjectStores): string => safeId(stores.config.space?.id ?? basename(stores.projectDir).replace(/@\d{8}-\d{6}$/, ''))
export const workflowWritePaths = (stores: ProjectStores) => [`${relative(stores.projectDir, stores.paths.workflows)}/**`, '.takt/workflow-revisions/**', '.takt/space-events.jsonl*']
const workflowWrite = (stores: ProjectStores) => <T>(fn: () => Promise<T>) => systemWrite(stores.projectDir, workflowWritePaths(stores), fn)
/** 编辑器路由用：调用方自己包 systemWrite，只有订阅轮询由 store 内部受控。 */
export function workflowSource(stores: ProjectStores) {
  return createWorkflowStore({ dir: stores.paths.workflows, historyDir: join(stores.taktDir, 'workflow-revisions'), gitCommit: false, guard: workflowWrite(stores) })
}
// 管家、Lead、空间概览随时会读写 workflow：读默认不补记修订，写一律走受控写入，否则运行中节点的守卫会把这些修订算成它越界。
export function workflowStore(stores: ProjectStores): WorkflowStore {
  const store = workflowSource(stores), guard = workflowWrite(stores)
  return {
    ...store,
    get: (id, options = {}) => options.record ? guard(() => store.get(id, options)) : store.get(id, { record: false }),
    list: (options = {}) => options.record ? guard(() => store.list(options)) : store.list({ record: false }),
    edit: (id, request) => guard(() => store.edit(id, request)),
    replaceSource: (id, request) => guard(() => store.replaceSource(id, request)),
    rollback: (id, rev, author, reason) => guard(() => store.rollback(id, rev, author, reason)),
    setLayout: (id, layout) => guard(() => store.setLayout(id, layout)),
  }
}
export const repoManager = (stores: ProjectStores) => createRepoManager({ projectDir: stores.projectDir, taktDir: stores.taktDir, repos: stores.config.repos ?? [] })
export async function spaceSummary(stores: ProjectStores): Promise<SpaceSummary> {
  const allRequirements = await stores.workspaces.listRequirements()
  const requirements = allRequirements.filter((item) => item.status !== 'archived')
  const runs = await stores.runs.list()
  const lastActivityAt = [...allRequirements.map(item => item.updatedAt), ...runs.map(run => run.endedAt ?? run.startedAt)].sort().at(-1)
  const pendingAttention = (await stores.attention.list({ pending: true })).filter((item) => requirements.some((req) => req.id === item.requirementId)).length
  return { pendingAttention, lastActivityAt, id: spaceId(stores), ...stores.config.project, requirements: requirements.length, active: requirements.filter((req) => req.status === 'active').length }
}
export async function spaceDetail(stores: ProjectStores): Promise<SpaceDetail> {
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
    workflows: (await workflowStore(stores).list()).map((item) => ({ ...item, runs: runs.filter((run) => run.workflowId === item.id).length })),
    knowledge: (stores.config.knowledge ?? []).map(({ id, kind }) => ({ id, kind, description: '' })) }
}

export { auditKnowledge as auditSpace, changeKnowledgeConfig as changeConfig, writeFileAtomic as atomicWrite } from '@taktflow/core'
import { auditKnowledge as auditSpace, changeKnowledgeConfig as changeConfig, writeFileAtomic as atomicWrite } from '@taktflow/core'
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

export function attachCrudServices(stores: ProjectStores): void {
  bindCrudServices(stores, {
    workflowEdit: async (id, baseRev, edits, context) => {
      const result = await workflowStore(stores).edit(id, { baseRev, edits, author: context.actor, reason: context.reason })
      if ('error' in result) throw new HttpError(result.error === 'conflict' ? 409 : 400, JSON.stringify(result))
      return result
    },
    workflowConvert: (id, context) => convertWorkflow(stores, id, { reason: context.reason! }, context.actor),
    configPatch: (patch, context) => patchConfig(stores, patch, context.actor, context.reason!),
  })
}
export function projectCommands(stores: ProjectStores, handlers: CommandHandlers = {}, runtime?: EngineDeps) {
  attachCrudServices(stores)
  return baseProjectCommands(stores, handlers, runtime)
}
export async function patchConfig(stores: ProjectStores, patch: Record<string, unknown>, author: Actor, reason: string): Promise<Config> {
  const allowed = new Set(['project', 'members', 'repos', 'roles', 'models', 'providers', 'budget', 'lead', 'route', 'retry', 'lessons', 'steward', 'knowledgeDefaults', 'contextBudgetTokens', 'sandbox'])
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new HttpError(400, '配置包含不允许修改的键')
  if (patch.project !== undefined && (!patch.project || typeof patch.project !== 'object' || Array.isArray(patch.project) || Object.keys(patch.project).some((key) => !['name', 'description', 'color'].includes(key)))) throw new HttpError(400, 'project 只能修改 name、description、color')
  const merge = (current: unknown, value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(value)
    const result: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) as Record<string, unknown> : {}
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new HttpError(400, '配置键不合法')
      if (entry === null) delete result[key]
      else result[key] = merge(result[key], entry)
    }
    return result
  }
  await changeConfig(stores, author, reason, 'config.patch', (config) => {
    const next = merge(config, patch) as Config
    text(next.project?.name, 'project.name')
    for (const key of ['description', 'color'] as const) if (next.project[key] !== undefined) text(next.project[key], `project.${key}`, true)
    if (next.members !== undefined) next.members = members(next.members)
    if (next.repos !== undefined) {
      if (!Array.isArray(next.repos)) throw new HttpError(400, 'repos 必须是数组')
      next.repos = next.repos.map((value) => repoBinding(value as unknown as Record<string, unknown>))
      if (new Set(next.repos.map((repo) => repo.id)).size !== next.repos.length) throw new HttpError(400, '仓库 ID 重复')
    }
    for (const key of Object.keys(config)) delete (config as unknown as Record<string, unknown>)[key]
    Object.assign(config, next)
  })
  return stores.config
}
