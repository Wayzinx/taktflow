/**
 * 可视化配置（docs/design/21）：设置页与 Lead 的 takt_config 共用的读写操作。
 *
 * - 读：`space.settings`（结构化设置）、`space.file.revisions`（角色 / 技能 / 配置的修订）；
 * - 写：`space.config.update`、`space.agent.*`、`space.skill.*`、`space.file.rollback`、
 *   `workflow.create` / `workflow.meta` / `workflow.delete`、`space.upgrade`。
 * 写操作都在 api-core 的租约里执行，要求 reason，写空间审计；角色 / 技能 / 配置每次写入都存修订快照，可恢复。
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import {
  listSkills, loadProfiles, parseFrontmatter, updateFrontmatter, validateEnvironment,
  type Actor, type AgentProfile, type EditableNode, type HarnessSelector, type KnowledgeKindInfo, type ProjectStores, type RunBudget,
  type SpaceConfigSettings, type SpaceFileRevision, type SpaceRevisionKind, type SpaceRoleSettings, type SpaceSettings,
  type SpaceSkillSettings, type SpaceUpgradePlan, type TaktConfig, type WorkflowTemplateInfo,
} from '@taktflow/core'
import { parseWorkflowSource, type WorkflowStore } from '@taktflow/workflow-source'
import { ApiError } from './errors.js'
import { atomicWrite, auditSpace, changeConfig, spaceFile } from './space.js'
import { spaceLock } from './space-lock.js'
import { text } from './validation.js'

export type SettingsReadOp = 'space.settings' | 'space.file.revisions'
export type SettingsWriteOp =
  | 'space.config.update' | 'space.agent.save' | 'space.agent.delete' | 'space.skill.save' | 'space.skill.delete'
  | 'space.file.rollback' | 'workflow.create' | 'workflow.meta' | 'workflow.delete' | 'space.upgrade'

export const SETTINGS_WRITE_OPS: readonly SettingsWriteOp[] = [
  'space.config.update', 'space.agent.save', 'space.agent.delete', 'space.skill.save', 'space.skill.delete',
  'space.file.rollback', 'workflow.create', 'workflow.meta', 'workflow.delete', 'space.upgrade',
]

export interface TemplateFile { name: string; content: string }
/** 新建流程与空间升级用的模板：独立 server 读仓库 templates/，dsh 插件用打包进插件的副本。 */
export interface SpaceTemplates { workflows: readonly TemplateFile[]; agents: readonly TemplateFile[] }
export type TemplateSource = () => SpaceTemplates | Promise<SpaceTemplates>

type Params = Record<string, string | undefined>
interface Context { stores: ProjectStores; store: WorkflowStore; templates?: TemplateSource }

const AUTONOMY = ['full', 'checkpoints', 'manual'] as const
const ROLE_ID = /^[a-z][a-z0-9-]{0,47}$/
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Lead 角色由宿主使用（CLI 群聊 / dsh Lead 预设），不能删除。 */
const PROTECTED_ROLES = new Set(['lead'])

export const KNOWLEDGE_KINDS: readonly KnowledgeKindInfo[] = [
  { kind: 'grep', label: '代码搜索', description: '在目录里按关键词和符号搜索（rg），适合“有没有这个东西、在哪”。',
    options: [{ key: 'root', label: '搜索目录', type: 'path', placeholder: '默认空间根' }, { key: 'ignore', label: '忽略', type: 'paths', placeholder: 'node_modules/**' }] },
  { kind: 'wiki', label: '文档目录', description: '一个放 Markdown 文档的目录：业务规则、产品知识、约定。',
    options: [{ key: 'root', label: '文档目录', type: 'path', placeholder: 'docs/wiki' }] },
  { kind: 'git-history', label: 'Git 历史', description: '提交记录与改动原因，回答“为什么这么写”。',
    options: [{ key: 'root', label: '仓库目录', type: 'path', placeholder: '默认空间根' }] },
  { kind: 'workspace', label: '历史需求', description: '过往需求的存放区（PRD、设计、报告），回答“以前怎么做的”。', options: [] },
]
const STUB_KINDS = new Set(['codegraph', 'database', 'api-registry'])

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  'taktflow-standard': '需求澄清 → PRD / 系分 / 测分各自交叉评审 → 对齐冻结 → 研发与用例自动化 → 研发测试循环 → 影响面评估 → 准出与报告。',
  sdlc: '需求、设计、实现、测试、报告的精简流程，评审轮次少。',
  'quick-fix': '小改动：简短说明 → 实现并自测 → 独立评审 → 交付校验。',
}

// ------------------------------------------------------------------ 读

export async function readSettings({ stores, store, templates }: Context, op: SettingsReadOp, params: Params): Promise<unknown> {
  if (op === 'space.file.revisions') {
    const { kind, name } = revisionTarget(params)
    return revisions(stores, kind, name)
  }
  const [roles, workflows] = await Promise.all([roleSettings(stores, store), store.list({ record: false })])
  const config = stores.config
  const registered = new Set((config.workflows ?? []).map((file) => normalize(file)))
  const fallbackDefault = workflows.find((w) => registered.has(registrationPath(stores, w.id)))?.id
  const defaultWorkflow = config.route?.defaultWorkflow ?? fallbackDefault
  const settings: SpaceSettings = {
    config: configSettings(config),
    roles,
    skills: await skillSettings(stores, roles),
    knowledgeKinds: [...KNOWLEDGE_KINDS],
    templates: templates ? workflowTemplates(await templates()) : [],
    workflows: workflows.map((w) => ({ id: w.id, title: w.title, file: w.file, default: w.id === defaultWorkflow, registered: registered.has(registrationPath(stores, w.id)) })),
    layout: await layoutIssues(stores, workflows.map((w) => w.id)),
  }
  return settings
}

function configSettings(config: TaktConfig): SpaceConfigSettings {
  return {
    ...(config.autonomy === undefined ? {} : { autonomy: config.autonomy }),
    ...(config.route?.defaultWorkflow === undefined ? {} : { defaultWorkflow: config.route.defaultWorkflow }),
    ...(config.environment === undefined ? {} : { environment: config.environment }),
    ...(config.selftest === undefined ? {} : { selftest: config.selftest }),
    ...(config.budget === undefined ? {} : { budget: config.budget }),
    knowledge: config.knowledge ?? [],
  }
}

async function roleSettings(stores: ProjectStores, store: WorkflowStore): Promise<SpaceRoleSettings[]> {
  const profiles = await loadProfiles(stores.paths)
  const files = await agentFiles(stores)
  const usage = await roleUsage(stores, store)
  return Object.values(profiles).map((profile) => {
    const file = files.get(profile.role)
    return { ...profile, file: file ? relative(stores.projectDir, file.path) : '', hash: file?.hash ?? '', usedBy: usage.get(profile.role) ?? [] }
  })
}

async function agentFiles(stores: ProjectStores): Promise<Map<string, { path: string; hash: string; content: string }>> {
  const result = new Map<string, { path: string; hash: string; content: string }>()
  let names: string[] = []
  try { names = await readdir(stores.paths.agents) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const name of names.filter((item) => item.endsWith('.md')).sort()) {
    const path = join(stores.paths.agents, name)
    const content = await readFile(path, 'utf8')
    const role = parseFrontmatter(content).data.role
    result.set(typeof role === 'string' && role ? role : name.slice(0, -3), { path, hash: sha256(content), content })
  }
  return result
}

/** 按源码字面量统计每个角色被哪些节点用到（role、reviewers、author 等任何 `role:` 字段）。代码值里的引用统计不到。 */
async function roleUsage(stores: ProjectStores, store: WorkflowStore): Promise<Map<string, Array<{ workflow: string; node: string }>>> {
  const usage = new Map<string, Array<{ workflow: string; node: string }>>()
  for (const summary of await store.list({ record: false })) {
    let source: string
    try { source = await readFile(resolve(dirname(stores.paths.workflows), summary.file), 'utf8') } catch { continue }
    const visit = (nodes: EditableNode[]) => {
      for (const node of nodes) {
        const roles = new Set<string>()
        for (const value of Object.values(node.props)) if (value.kind === 'literal') collectRoles(value.value, roles)
        for (const role of roles) {
          const list = usage.get(role) ?? []
          list.push({ workflow: summary.id, node: node.id })
          usage.set(role, list)
        }
        if (node.body) visit(node.body)
      }
    }
    visit(parseWorkflowSource(source, summary.file).model.nodes)
  }
  return usage
}

function collectRoles(value: unknown, roles: Set<string>, key?: string): void {
  if (typeof value === 'string') { if (key === 'role') roles.add(value); return }
  if (Array.isArray(value)) { for (const item of value) collectRoles(item, roles); return }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collectRoles(v, roles, k)
}

async function skillSettings(stores: ProjectStores, roles: SpaceRoleSettings[]): Promise<SpaceSkillSettings[]> {
  const skills = await listSkills(stores.paths.skills)
  return Promise.all(skills.map(async (skill) => {
    const content = await readFile(join(stores.projectDir, skill.path), 'utf8')
    const { body } = parseFrontmatter(content)
    return { name: skill.name, description: skill.description, body: body.trim(), file: skill.path, hash: sha256(content),
      usedBy: roles.filter((role) => role.skills.includes(skill.name)).map((role) => role.role) }
  }))
}

const TEMPLATE_ORDER = ['taktflow-standard', 'quick-fix', 'sdlc']

function workflowTemplates(templates: SpaceTemplates): WorkflowTemplateInfo[] {
  const rank = (id: string) => { const i = TEMPLATE_ORDER.indexOf(id); return i < 0 ? TEMPLATE_ORDER.length : i }
  return templates.workflows.filter((file) => file.name.endsWith('.workflow.ts')).map((file) => {
    const id = file.name.slice(0, -'.workflow.ts'.length)
    const title = parseWorkflowSource(file.content, file.name).model.meta.title
    return { id, title: title.kind === 'literal' && typeof title.value === 'string' ? title.value : id, description: TEMPLATE_DESCRIPTIONS[id] ?? '' }
  }).sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
}

async function layoutIssues(stores: ProjectStores, workflowIds: string[]): Promise<SpaceSettings['layout']> {
  const issues: string[] = []
  for (const file of stores.config.workflows ?? []) {
    if (!await exists(resolve(stores.projectDir, file))) issues.push(`配置引用的流程文件不存在：${file}`)
  }
  if (workflowIds.length === 0) issues.push('空间里还没有任何流程')
  return { legacy: issues.length > 0, issues }
}

// ------------------------------------------------------------------ 写

export async function writeSettings(ctx: Context, op: SettingsWriteOp, params: Params, input: Record<string, unknown>, author: Actor): Promise<unknown> {
  const { stores, store } = ctx
  const reason = text(input.reason, 'reason')
  switch (op) {
    case 'space.config.update': {
      const patch = input.patch
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError(400, 'patch 必须是对象')
      const ids = (await store.list({ record: false })).map((w) => w.id)
      await recordedConfigChange(stores, author, reason, '修改运行策略', (config) => applyConfigPatch(stores, config, patch as Record<string, unknown>, ids))
      return readSettings(ctx, 'space.settings', {})
    }
    case 'space.agent.save': return saveAgent(ctx, params, input, author, reason)
    case 'space.agent.delete': {
      const role = roleId(params.role)
      if (PROTECTED_ROLES.has(role)) throw new ApiError(409, `${role} 角色由宿主使用，不能删除`)
      const users = (await roleUsage(stores, store)).get(role) ?? []
      if (users.length) throw new ApiError(409, `角色 ${role} 正被流程使用：${users.map((u) => `${u.workflow}/${u.node}`).join('、')}`, { code: 'TAKT_IN_USE', references: users })
      const file = (await agentFiles(stores)).get(role)
      if (!file) throw new ApiError(404, `角色不存在：${role}`)
      await recordedDelete(stores, 'agent', role, file.path, author, reason, `删除角色 ${role}`)
      return { role, deleted: true }
    }
    case 'space.skill.save': return saveSkill(ctx, params, input, author, reason)
    case 'space.skill.delete': {
      const name = skillId(params.name)
      const users = (await roleSettings(stores, store)).filter((role) => role.skills.includes(name)).map((role) => role.role)
      if (users.length) throw new ApiError(409, `技能 ${name} 正被角色使用：${users.join('、')}`, { code: 'TAKT_IN_USE', references: users })
      const file = join(stores.paths.skills, name, 'SKILL.md')
      if (!await exists(file)) throw new ApiError(404, `技能不存在：${name}`)
      await recordedDelete(stores, 'skill', name, file, author, reason, `删除技能 ${name}`)
      // 技能目录里可能还有脚本等文件，只在目录空了时删除目录。
      await rmdir(dirname(file)).catch(() => undefined)
      return { name, deleted: true }
    }
    case 'space.file.rollback': {
      const { kind, name } = revisionTarget(params)
      const rev = text(input.rev, 'rev')
      if (!/^[a-f0-9]{64}$/.test(rev)) throw new ApiError(400, 'rev 不合法')
      const target = (await revisions(stores, kind, name)).find((item) => item.rev === rev)
      if (!target) throw new ApiError(404, '修订不存在')
      const content = await readFile(join(revisionDir(stores, kind, name), `${rev}.txt`), 'utf8')
      const path = revisionFile(stores, kind, name)
      await validateContent(kind, content, name)
      await recordedWrite(stores, kind, name, path, content, author, reason, `恢复到 ${rev.slice(0, 8)}`)
      if (kind === 'config') stores.config = JSON.parse(content) as TaktConfig
      return { kind, name, rev }
    }
    case 'workflow.create': return createWorkflow(ctx, input, author, reason)
    case 'workflow.meta': {
      const id = workflowId(params.id)
      const summary = (await store.list({ record: false })).find((w) => w.id === id)
      if (!summary) throw new ApiError(404, `workflow 不存在：${id}`)
      if (input.title !== undefined) {
        const title = text(input.title, 'title')
        const result = await store.edit(id, { baseRev: summary.rev, edits: [{ op: 'setMeta', key: 'title', value: title }], reason, author })
        if ('error' in result) throw new ApiError(result.error === 'conflict' ? 409 : 400, `修改标题失败：${diagnosticText(result)}`, result as never)
      }
      if (input.default === true) {
        await recordedConfigChange(stores, author, reason, `默认流程改为 ${id}`, (config) => {
          config.route = { ...config.route, defaultWorkflow: id }
          register(stores, config, id)
        })
      }
      return readSettings(ctx, 'space.settings', {})
    }
    case 'workflow.delete': {
      const id = workflowId(params.id)
      const all = await store.list({ record: false })
      if (!all.some((w) => w.id === id)) throw new ApiError(404, `workflow 不存在：${id}`)
      if (all.length === 1) throw new ApiError(409, '这是空间里唯一的流程，不能删除')
      const active = (await stores.runs.list()).filter((run) => run.workflowId === id && ['running', 'waiting_human', 'pending'].includes(run.status))
      if (active.length) throw new ApiError(409, `流程 ${id} 还有 ${active.length} 个运行未结束：${active.map((r) => r.runId).join('、')}`, { code: 'TAKT_IN_USE', references: active.map((r) => r.runId) })
      const removed = await store.remove(id)
      await recordedConfigChange(stores, author, reason, `删除流程 ${id}`, (config) => {
        const file = registrationPath(stores, id)
        config.workflows = (config.workflows ?? []).filter((item) => normalize(item) !== file)
        if (config.route?.defaultWorkflow === id) {
          const { defaultWorkflow: _drop, ...route } = config.route
          config.route = Object.keys(route).length ? route : undefined
          if (!config.route) delete config.route
        }
      })
      return { ...removed, deleted: true }
    }
    case 'space.upgrade': return upgradeSpace(ctx, input.dryRun === true, author, reason)
  }
}

function applyConfigPatch(stores: ProjectStores, config: TaktConfig, patch: Record<string, unknown>, workflowIds: string[]): void {
  const allowed = new Set(['autonomy', 'defaultWorkflow', 'environment', 'selftest', 'budget', 'knowledge'])
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new ApiError(400, `不能通过设置页修改 ${key}`)
  const has = (key: string) => Object.hasOwn(patch, key)
  if (has('autonomy')) {
    const value = patch.autonomy
    if (value === null) delete config.autonomy
    else if (!AUTONOMY.includes(value as never)) throw new ApiError(400, 'autonomy 只能是 full / checkpoints / manual')
    else config.autonomy = value as TaktConfig['autonomy']
  }
  if (has('defaultWorkflow')) {
    const value = patch.defaultWorkflow
    if (value === null) {
      if (config.route) { delete config.route.defaultWorkflow; if (!Object.keys(config.route).length) delete config.route }
    } else {
      const id = workflowId(value)
      if (!workflowIds.includes(id)) throw new ApiError(400, `流程不存在：${id}`)
      config.route = { ...config.route, defaultWorkflow: id }
      register(stores, config, id)
    }
  }
  if (has('environment')) {
    const value = patch.environment
    if (value === null) delete config.environment
    else {
      const env = clean(value, 'environment') as NonNullable<TaktConfig['environment']>
      try { validateEnvironment(env) } catch (error) { throw new ApiError(400, (error as Error).message) }
      if (env.testCommand !== undefined && (typeof env.testCommand !== 'string' || !env.testCommand.trim())) throw new ApiError(400, 'environment.testCommand 必须是非空命令')
      config.environment = env
    }
  }
  if (has('selftest')) {
    const value = patch.selftest
    if (value === null) delete config.selftest
    else {
      const selftest = clean(value, 'selftest') as Record<string, unknown>
      for (const key of Object.keys(selftest)) if (!['timeoutMs', 'allowedCommands'].includes(key)) throw new ApiError(400, `selftest 不支持 ${key}`)
      const timeout = selftest.timeoutMs
      if (timeout !== undefined && (!Number.isSafeInteger(timeout) || (timeout as number) < 1000 || (timeout as number) > 3_600_000)) throw new ApiError(400, 'selftest.timeoutMs 必须是 1000..3600000 的整数')
      if (selftest.allowedCommands !== undefined) stringList(selftest.allowedCommands, 'selftest.allowedCommands')
      config.selftest = selftest as TaktConfig['selftest']
    }
  }
  if (has('budget')) {
    const value = patch.budget
    if (value === null) delete config.budget
    else {
      const budget = clean(value, 'budget') as Record<string, unknown>
      for (const [key, number] of Object.entries(budget)) {
        if (!['tokens', 'costUsd', 'minutes', 'concurrency'].includes(key)) throw new ApiError(400, `budget 不支持 ${key}`)
        if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) throw new ApiError(400, `budget.${key} 必须是正数`)
      }
      config.budget = budget as RunBudget
    }
  }
  if (has('knowledge')) {
    const value = patch.knowledge
    if (value === null) delete config.knowledge
    else config.knowledge = knowledgeList(value)
  }
}

/** 去掉值为 null / 空串的字段，便于表单直接提交。 */
function clean(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, `${name} 必须是对象`)
  const entries = Object.entries(value)
  // 环境变量值由 core validateEnvironment 校验：空串/空白是合法 string，null/number 必须报错而不是被静默删除。
  // Object.fromEntries 用 CreateDataProperty 构造，__proto__ 等键不会污染原型。
  if (name === 'environment.env') return Object.fromEntries(entries)
  return Object.fromEntries(entries.filter(([, v]) => v !== null && v !== '').map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? clean(v, `${name}.${k}`) : v]))
}

export function knowledgeList(value: unknown): NonNullable<TaktConfig['knowledge']> {
  if (!Array.isArray(value)) throw new ApiError(400, 'knowledge 必须是数组')
  const seen = new Set<string>()
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new ApiError(400, '知识源必须是对象')
    const { id, kind, options } = item as Record<string, unknown>
    const key = text(id, 'knowledge.id')
    if (!/^[A-Za-z0-9][\w-]*$/.test(key)) throw new ApiError(400, `知识源 id 不合法：${key}`)
    if (seen.has(key)) throw new ApiError(400, `知识源 id 重复：${key}`)
    seen.add(key)
    const info = KNOWLEDGE_KINDS.find((k) => k.kind === kind)
    if (!info && !STUB_KINDS.has(String(kind))) throw new ApiError(400, `未知知识源类型：${String(kind)}`)
    const result: { id: string; kind: string; options?: Record<string, unknown> } = { id: key, kind: String(kind) }
    if (options !== undefined && options !== null) {
      const opts = clean(options, `知识源 ${key} 的选项`)
      const allowed = new Map((info?.options ?? []).map((o) => [o.key, o.type]))
      for (const [name, v] of Object.entries(opts)) {
        const type = allowed.get(name)
        if (!type) throw new ApiError(400, `知识源 ${key}（${String(kind)}）不支持选项 ${name}`)
        if (type === 'path') relativeSpacePath(v, `${key}.${name}`)
        else stringList(v, `${key}.${name}`)
      }
      if (Object.keys(opts).length) result.options = opts
    }
    return result
  })
}

async function saveAgent({ stores, store }: Context, params: Params, input: Record<string, unknown>, author: Actor, reason: string): Promise<unknown> {
  const role = roleId(params.role)
  const files = await agentFiles(stores)
  const existing = files.get(role)
  const create = input.create === true
  if (create && existing) throw new ApiError(409, `角色已存在：${role}`)
  if (!create && !existing) throw new ApiError(404, `角色不存在：${role}`)
  if (input.baseHash !== undefined && existing && input.baseHash !== existing.hash) throw new ApiError(409, '角色在你编辑期间被修改过，请刷新后再保存', { code: 'TAKT_STALE' })
  const profile = (input.profile ?? {}) as Record<string, unknown>
  if (typeof profile !== 'object' || Array.isArray(profile)) throw new ApiError(400, 'profile 必须是对象')
  const allowed = new Set(['title', 'description', 'skills', 'writeScope', 'readScope', 'model', 'allowBash'])
  for (const key of Object.keys(profile)) if (!allowed.has(key)) throw new ApiError(400, `角色表单不支持字段 ${key}`)

  let base = existing?.content
  if (create) {
    const from = input.copyFrom === undefined ? undefined : files.get(roleId(input.copyFrom))
    if (input.copyFrom !== undefined && !from) throw new ApiError(404, `要复制的角色不存在：${String(input.copyFrom)}`)
    base = from ? updateFrontmatter(from.content, { role }) : updateFrontmatter('', { role, title: role, description: '', harness: { harness: 'claude-code' }, skills: [], writeScope: [] }, '')
  }
  const current = parseFrontmatter(base!).data
  const patch: Record<string, unknown> = {}
  if (profile.title !== undefined) patch.title = text(profile.title, 'title')
  if (profile.description !== undefined) patch.description = typeof profile.description === 'string' ? profile.description : text(profile.description, 'description')
  if (profile.skills !== undefined) patch.skills = stringList(profile.skills, 'skills', true)
  if (profile.writeScope !== undefined) patch.writeScope = globList(profile.writeScope, 'writeScope')
  if (profile.readScope !== undefined) patch.readScope = profile.readScope === null ? undefined : globList(profile.readScope, 'readScope')
  if (profile.allowBash !== undefined) patch.allowBash = profile.allowBash === null ? undefined : profile.allowBash === true
  if (profile.model !== undefined) {
    const harness: HarnessSelector = typeof current.harness === 'string' ? { harness: current.harness } : { ...(current.harness as HarnessSelector) }
    if (profile.model === null || profile.model === '') delete harness.model
    else harness.model = text(profile.model, 'model')
    patch.harness = Object.keys(harness).length === 1 && typeof current.harness === 'string' ? current.harness : harness
  }
  if (Array.isArray(patch.skills)) {
    const known = new Set((await listSkills(stores.paths.skills)).map((s) => s.name))
    const missing = (patch.skills as string[]).filter((s) => !known.has(s))
    if (missing.length) throw new ApiError(400, `技能不存在：${missing.join('、')}`)
  }
  const instructions = input.instructions === undefined ? undefined : typeof input.instructions === 'string' ? input.instructions : text(input.instructions, 'instructions')
  const content = updateFrontmatter(base!, patch, instructions)
  await validateContent('agent', content, role)
  const path = existing?.path ?? join(stores.paths.agents, `${role}.md`)
  await recordedWrite(stores, 'agent', role, path, content, author, reason, create ? `新建角色 ${role}` : `修改角色 ${role}`)
  return (await roleSettings(stores, store)).find((item) => item.role === role)
}

async function saveSkill({ stores, store }: Context, params: Params, input: Record<string, unknown>, author: Actor, reason: string): Promise<unknown> {
  const name = skillId(params.name)
  const path = join(stores.paths.skills, name, 'SKILL.md')
  const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
  const create = input.create === true
  if (create && existing !== undefined) throw new ApiError(409, `技能已存在：${name}`)
  if (!create && existing === undefined) throw new ApiError(404, `技能不存在：${name}`)
  if (input.baseHash !== undefined && existing !== undefined && input.baseHash !== sha256(existing)) throw new ApiError(409, '技能在你编辑期间被修改过，请刷新后再保存', { code: 'TAKT_STALE' })
  const description = text(input.description, 'description')
  const body = input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : text(input.body, 'body')
  const content = updateFrontmatter(existing ?? '', { name, description }, body ?? (existing === undefined ? '' : undefined))
  await recordedWrite(stores, 'skill', name, path, content, author, reason, create ? `新建技能 ${name}` : `修改技能 ${name}`)
  const roles = await roleSettings(stores, store)
  return (await skillSettings(stores, roles)).find((skill) => skill.name === name)
}

async function createWorkflow({ stores, store, templates }: Context, input: Record<string, unknown>, author: Actor, reason: string): Promise<unknown> {
  const id = workflowId(input.id)
  const title = input.title === undefined ? undefined : text(input.title, 'title')
  const from = input.from as { template?: unknown; workflow?: unknown } | undefined
  if (!from || typeof from !== 'object' || (from.template === undefined) === (from.workflow === undefined)) throw new ApiError(400, 'from 必须是 { template } 或 { workflow } 之一')
  let source: string
  let extraFiles: TemplateFile[] = []
  if (from.template !== undefined) {
    if (!templates) throw new ApiError(501, '当前宿主没有提供流程模板')
    const all = await templates()
    const name = `${workflowId(from.template)}.workflow.ts`
    const file = all.workflows.find((item) => item.name === name)
    if (!file) throw new ApiError(404, `模板不存在：${String(from.template)}`)
    source = file.content
    extraFiles = helperFiles(file.content, all.workflows)
  } else {
    const sourceId = workflowId(from.workflow)
    const summary = (await store.list({ record: false })).find((w) => w.id === sourceId)
    if (!summary) throw new ApiError(404, `workflow 不存在：${sourceId}`)
    source = await readFile(resolve(dirname(stores.paths.workflows), summary.file), 'utf8')
  }
  source = renameWorkflowId(source, id)
  const created = await store.create(id, { source, author, reason, extraFiles })
  if ('error' in created) throw new ApiError(created.error === 'conflict' ? 409 : 400, `新建流程校验失败：${diagnosticText(created)}`, created as never)
  if (title !== undefined && created.model.meta.title.kind === 'literal' && created.model.meta.title.value !== title) {
    const edited = await store.edit(id, { baseRev: created.rev, edits: [{ op: 'setMeta', key: 'title', value: title }], reason, author })
    if ('error' in edited) throw new ApiError(400, `设置流程标题失败：${diagnosticText(edited)}`, edited as never)
  }
  await recordedConfigChange(stores, author, reason, `新建流程 ${id}`, (config) => register(stores, config, id))
  return { id, file: created.file }
}

/** 把 defineWorkflow 里的 id 字面量换成新 id（只换第一个，即流程自身的 id）。 */
function renameWorkflowId(source: string, id: string): string {
  const start = source.indexOf('defineWorkflow(')
  if (start < 0) throw new ApiError(400, '源码里没有 defineWorkflow(...)')
  const pattern = /\bid\s*:\s*(['"])([^'"\n]+)\1/g
  pattern.lastIndex = start
  const match = pattern.exec(source)
  if (!match) throw new ApiError(400, '源码里找不到流程 id')
  return source.slice(0, match.index) + `id: '${id}'` + source.slice(match.index + match[0].length)
}

/** 模板源码相对导入的辅助文件（递归）。 */
function helperFiles(source: string, files: readonly TemplateFile[], seen = new Set<string>()): TemplateFile[] {
  const result: TemplateFile[] = []
  for (const match of source.matchAll(/from\s+['"]\.\/([\w.-]+?)(?:\.js|\.ts)['"]/g)) {
    const name = `${match[1]}.ts`
    if (seen.has(name)) continue
    seen.add(name)
    const file = files.find((item) => item.name === name)
    if (!file) continue
    result.push(file, ...helperFiles(file.content, files, seen))
  }
  return result
}

async function upgradeSpace(ctx: Context, dryRun: boolean, author: Actor, reason: string): Promise<SpaceUpgradePlan> {
  const { stores, store, templates } = ctx
  if (!templates) throw new ApiError(501, '当前宿主没有提供模板，无法升级空间')
  const all = await templates()
  const changes: SpaceUpgradePlan['changes'] = []
  const existingIds = new Set((await store.list({ record: false })).map((w) => w.id))
  const addFiles: Array<{ path: string; content: string }> = []
  const register: string[] = []
  for (const file of all.workflows) {
    const target = join(stores.paths.workflows, file.name)
    if (await exists(target)) continue
    const id = file.name.endsWith('.workflow.ts') ? file.name.slice(0, -'.workflow.ts'.length) : undefined
    if (id && existingIds.has(id)) continue
    addFiles.push({ path: target, content: file.content })
    changes.push({ kind: 'add-file', target: relative(stores.projectDir, target), detail: id ? `补充流程模板 ${id}` : '流程辅助文件' })
    if (id) { register.push(id); changes.push({ kind: 'register-workflow', target: id, detail: '登记到 takt.config.json' }) }
  }
  const roles = await agentFiles(stores)
  for (const file of all.agents) {
    const role = file.name.replace(/\.md$/, '')
    if (roles.has(role)) continue
    const target = join(stores.paths.agents, file.name)
    if (await exists(target)) continue
    addFiles.push({ path: target, content: file.content })
    changes.push({ kind: 'add-file', target: relative(stores.projectDir, target), detail: `补充默认角色 ${role}` })
  }
  // 悬空引用：文件不存在且这次升级也不会补上。
  const adding = new Set(addFiles.map((file) => normalize(relative(stores.projectDir, file.path))))
  for (const file of stores.config.workflows ?? []) {
    if (!adding.has(normalize(file)) && !await exists(resolve(stores.projectDir, file))) changes.push({ kind: 'drop-workflow', target: file, detail: '配置里引用的流程文件不存在，移除引用' })
  }
  const setDefault = !stores.config.route?.defaultWorkflow && register.includes('taktflow-standard')
  if (setDefault) changes.push({ kind: 'set-default', target: 'taktflow-standard', detail: '默认流程设为标准交付流水线' })
  const plan: SpaceUpgradePlan = { legacy: changes.length > 0, changes, applied: false }
  if (dryRun || !changes.length) return plan
  for (const file of addFiles) await atomicWrite(file.path, file.content)
  const droppedFiles = new Set(changes.filter((c) => c.kind === 'drop-workflow').map((c) => normalize(c.target)))
  await recordedConfigChange(stores, author, reason, `升级空间：${changes.length} 项变更`, (config) => {
    config.workflows = (config.workflows ?? []).filter((file) => !droppedFiles.has(normalize(file)))
    for (const id of register) registerConfig(stores, config, id)
    if (setDefault) config.route = { ...config.route, defaultWorkflow: 'taktflow-standard' }
  })
  return { ...plan, applied: true }
}

// ------------------------------------------------------------------ 修订

function revisionDir(stores: ProjectStores, kind: SpaceRevisionKind, name: string): string {
  return join(stores.taktDir, 'space-revisions', kind, name)
}

function revisionFile(stores: ProjectStores, kind: SpaceRevisionKind, name: string): string {
  if (kind === 'config') return join(stores.projectDir, 'takt.config.json')
  if (kind === 'skill') return join(stores.paths.skills, name, 'SKILL.md')
  return join(stores.paths.agents, `${name}.md`)
}

function revisionTarget(params: Params): { kind: SpaceRevisionKind; name: string } {
  const kind = params.kind
  if (kind === 'config') return { kind, name: 'takt.config' }
  if (kind === 'agent') return { kind, name: roleId(params.name) }
  if (kind === 'skill') return { kind, name: skillId(params.name) }
  throw new ApiError(400, 'kind 必须是 agent / skill / config')
}

async function revisions(stores: ProjectStores, kind: SpaceRevisionKind, name: string): Promise<SpaceFileRevision[]> {
  const log = await readFile(join(revisionDir(stores, kind, name), 'log.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  return log.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SpaceFileRevision).reverse()
}

async function appendRevision(stores: ProjectStores, kind: SpaceRevisionKind, name: string, content: string, author: Actor, reason: string, summary: string): Promise<void> {
  const dir = revisionDir(stores, kind, name)
  await mkdir(dir, { recursive: true })
  const previous = (await revisions(stores, kind, name))[0]
  const rev = sha256(content)
  if (previous?.rev === rev) return
  await atomicWrite(join(dir, `${rev}.txt`), content)
  const entry: SpaceFileRevision = { rev, ...(previous ? { parent: previous.rev } : {}), author, reason, summary, at: new Date().toISOString() }
  await appendFile(join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n')
}

/** 第一次通过设置页改一个文件时，先把改之前的内容记成初始修订，保证能恢复到原样。 */
async function ensureBaseline(stores: ProjectStores, kind: SpaceRevisionKind, name: string, path: string): Promise<void> {
  if ((await revisions(stores, kind, name)).length) return
  const before = await readFile(path, 'utf8').catch(() => undefined)
  if (before !== undefined) await appendRevision(stores, kind, name, before, { type: 'system', id: 'space-settings' }, '记录修改前的内容', '初始版本')
}

async function recordedWrite(stores: ProjectStores, kind: SpaceRevisionKind, name: string, path: string, content: string, author: Actor, reason: string, summary: string): Promise<void> {
  await spaceLock(path, async () => {
    await ensureBaseline(stores, kind, name, path)
    await auditSpace(stores, author, reason, summary)
    await atomicWrite(path, content)
    await appendRevision(stores, kind, name, content, author, reason, summary)
  })
}

async function recordedDelete(stores: ProjectStores, kind: SpaceRevisionKind, name: string, path: string, author: Actor, reason: string, summary: string): Promise<void> {
  await spaceLock(path, async () => {
    await ensureBaseline(stores, kind, name, path)
    await auditSpace(stores, author, reason, summary)
    await rm(path)
  })
}

async function recordedConfigChange(stores: ProjectStores, author: Actor, reason: string, summary: string, change: (config: TaktConfig) => void): Promise<void> {
  const path = join(stores.projectDir, 'takt.config.json')
  await ensureBaseline(stores, 'config', 'takt.config', path)
  await changeConfig(stores, author, reason, summary, change)
  await appendRevision(stores, 'config', 'takt.config', await readFile(path, 'utf8'), author, reason, summary)
}

async function validateContent(kind: SpaceRevisionKind, content: string, name: string): Promise<void> {
  if (kind === 'config') {
    let config: TaktConfig
    try { config = JSON.parse(content) as TaktConfig } catch { throw new ApiError(400, '配置不是合法 JSON') }
    if (typeof config.project?.name !== 'string' || !Array.isArray(config.workflows)) throw new ApiError(400, '配置缺 project.name 或 workflows')
    try { validateEnvironment(config.environment) } catch (error) { throw new ApiError(400, (error as Error).message) }
    return
  }
  if (kind === 'skill') { try { parseFrontmatter(content) } catch (error) { throw new ApiError(400, (error as Error).message) }; return }
  // 角色：用 core 的加载器校验（必填 harness、数组字段类型等），和运行时读角色同一套规则。
  const dir = await mkdtemp(join(tmpdir(), 'takt-agent-check-'))
  try {
    await atomicWrite(join(dir, 'agents', `${name}.md`), content)
    const profiles = await loadProfiles(join(dir, 'agents')).catch((error: Error) => { throw new ApiError(400, error.message) })
    const profile = Object.values(profiles)[0] as AgentProfile | undefined
    if (!profile || profile.role !== name) throw new ApiError(400, `角色文件里的 role 必须是 ${name}`)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

// ------------------------------------------------------------------ 小工具

function register(stores: ProjectStores, config: TaktConfig, id: string): void { registerConfig(stores, config, id) }
function registerConfig(stores: ProjectStores, config: TaktConfig, id: string): void {
  const file = registrationPath(stores, id)
  if (!(config.workflows ?? []).some((item) => normalize(item) === file)) config.workflows = [...config.workflows ?? [], file]
}
function registrationPath(stores: ProjectStores, id: string): string {
  return normalize(relative(stores.projectDir, join(stores.paths.workflows, `${id}.workflow.ts`)))
}
function diagnosticText(result: { error: string; diagnostics?: Array<{ severity: string; message: string }> }): string {
  if (result.error === 'conflict') return '与并发修改冲突，请刷新后重试'
  return (result.diagnostics ?? []).filter((d) => d.severity === 'error').map((d) => d.message).slice(0, 3).join('；') || '未知错误'
}
function normalize(file: string): string { return file.replace(/\\/g, '/').replace(/^\.\//, '') }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
async function exists(path: string): Promise<boolean> { return readFile(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === 'EISDIR') }

function roleId(value: unknown): string {
  const id = text(value, 'role')
  if (!ROLE_ID.test(id)) throw new ApiError(400, `角色名只能用小写字母、数字和连字符：${id}`)
  return id
}
function skillId(value: unknown): string {
  const id = text(value, 'name')
  if (!SKILL_ID.test(id)) throw new ApiError(400, `技能名只能用小写字母、数字和连字符：${id}`)
  return id
}
function workflowId(value: unknown): string {
  const id = text(value, 'id')
  if (!WORKFLOW_ID.test(id)) throw new ApiError(400, `流程 id 只能用小写字母、数字和连字符：${id}`)
  return id
}
function stringList(value: unknown, name: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new ApiError(400, `${name} 必须是非空字符串数组`)
  if (!allowEmpty && value.length === 0) throw new ApiError(400, `${name} 不能为空`)
  return [...new Set(value.map((item: string) => item.trim()))]
}
function globList(value: unknown, name: string): string[] {
  const list = stringList(value, name, true)
  for (const glob of list) if (glob.startsWith('/') || glob.split('/').includes('..')) throw new ApiError(400, `${name} 只能写空间内的相对路径：${glob}`)
  return list
}
function relativeSpacePath(value: unknown, name: string): string {
  const path = text(value, name)
  if (path.startsWith('/') || path.split('/').includes('..')) throw new ApiError(400, `${name} 只能写空间内的相对路径`)
  return path
}

/** 从模板目录读模板（`workflows/*.ts`、`agents/*.md`）；独立 server / CLI 用仓库的 templates/。 */
export async function readTemplateDir(dir: string): Promise<SpaceTemplates> {
  const read = async (sub: string, suffix: RegExp): Promise<TemplateFile[]> => {
    const names = await readdir(join(dir, sub)).catch(() => [] as string[])
    return Promise.all(names.filter((name) => suffix.test(name)).sort().map(async (name) => ({ name, content: await readFile(join(dir, sub, name), 'utf8') })))
  }
  return { workflows: await read('workflows', /\.ts$/), agents: await read('agents', /\.md$/) }
}

/** 源文件编辑（`space.file.edit`）也走同一套校验和修订，和表单保存一致。 */
export async function editSpaceFile(stores: ProjectStores, kind: 'agent' | 'skill', name: string, path: string, content: string, author: Actor, reason: string): Promise<void> {
  await validateContent(kind, content, name)
  await recordedWrite(stores, kind, name, path, content, author, reason, `编辑源文件 ${relative(stores.projectDir, path)}`)
}
