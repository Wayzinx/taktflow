/**
 * 可视化配置的演示数据源（docs/design/21）：在内存里维护结构化设置，行为对齐服务端的校验与 409。
 * 角色与技能从演示空间（mock-space.ts）的数据起步；流程列表取自演示 workflow 存储。
 */
import type {
  SpaceConfigSettings, SpaceFileRevision, SpaceRoleSettings, SpaceSettings, SpaceSkillSettings, WorkflowSummary,
} from '@taktflow/core'
import type { DataSource } from './source'
import type { MockSpace } from './mock-space'

type ConfigApi = Pick<DataSource, 'settings' | 'updateConfig' | 'saveRole' | 'deleteRole' | 'saveSkill' | 'deleteSkill' | 'fileRevisions' | 'rollbackFile' | 'createWorkflow' | 'updateWorkflowMeta' | 'deleteWorkflow' | 'upgradeSpace'>

const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
class MockApiError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) { super(message) }
}
const fail = (status: number, message: string, detail?: unknown) => Promise.reject(new MockApiError(status, message, detail))
const hash = (v: unknown) => { let h = 0; for (const c of JSON.stringify(v)) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(16).padStart(8, '0').repeat(8) }

const KNOWLEDGE_KINDS: SpaceSettings['knowledgeKinds'] = [
  { kind: 'grep', label: '代码搜索', description: '在目录里按关键词和符号搜索（rg），适合“有没有这个东西、在哪”。', options: [{ key: 'root', label: '搜索目录', type: 'path', placeholder: '默认空间根' }, { key: 'ignore', label: '忽略', type: 'paths', placeholder: 'node_modules/**' }] },
  { kind: 'wiki', label: '文档目录', description: '一个放 Markdown 文档的目录：业务规则、产品知识、约定。', options: [{ key: 'root', label: '文档目录', type: 'path', placeholder: 'docs/wiki' }] },
  { kind: 'git-history', label: 'Git 历史', description: '提交记录与改动原因，回答“为什么这么写”。', options: [{ key: 'root', label: '仓库目录', type: 'path', placeholder: '默认空间根' }] },
  { kind: 'workspace', label: '历史需求', description: '过往需求的存放区（PRD、设计、报告），回答“以前怎么做的”。', options: [] },
]
const TEMPLATES: SpaceSettings['templates'] = [
  { id: 'taktflow-standard', title: '标准交付流水线（完整）', description: '需求澄清 → PRD / 系分 / 测分各自交叉评审 → 对齐冻结 → 研发与用例自动化 → 研发测试循环 → 影响面评估 → 准出与报告。' },
  { id: 'sdlc', title: '精简 SDLC', description: '需求、设计、实现、测试、报告的精简流程，评审轮次少。' },
  { id: 'quick-fix', title: '轻量改动', description: '小改动：简短说明 → 实现并自测 → 独立评审 → 交付校验。' },
]

interface State {
  config: SpaceConfigSettings
  roles: Map<string, Omit<SpaceRoleSettings, 'usedBy' | 'hash'>>
  skills: Map<string, Omit<SpaceSkillSettings, 'usedBy' | 'hash'>>
  revisions: Map<string, Array<SpaceFileRevision & { snapshot: unknown }>>
  extraWorkflows: WorkflowSummary[]
  deletedWorkflows: Set<string>
  titles: Map<string, string>
}

function initialState(sp: MockSpace): State {
  const roles = new Map<string, Omit<SpaceRoleSettings, 'usedBy' | 'hash'>>()
  for (const a of sp.detail.agents) {
    const body = (sp.files.get(`agent:${a.role}`) ?? '').split('---').slice(2).join('---').trim()
    roles.set(a.role, { ...a, skills: [], instructions: body, file: `agents/${a.role}.md` })
  }
  const skills = new Map<string, Omit<SpaceSkillSettings, 'usedBy' | 'hash'>>()
  for (const s of sp.detail.skills) {
    const body = (sp.files.get(`skill:${s.name}`) ?? '').split('---').slice(2).join('---').trim()
    skills.set(s.name, { name: s.name, description: s.description, body, file: s.path })
  }
  if (roles.has('automation') && skills.has('playwright-e2e')) roles.get('automation')!.skills = ['playwright-e2e']
  if (roles.has('dev') && skills.has('money-format')) roles.get('dev')!.skills = ['money-format', 'csv-export']
  return { config: { autonomy: 'full', knowledge: sp.detail.knowledge.map(({ id, kind }) => ({ id, kind })) }, roles, skills, revisions: new Map(), extraWorkflows: [], deletedWorkflows: new Set(), titles: new Map() }
}

export function createMockConfig(current: () => MockSpace | undefined, workflows: () => Promise<WorkflowSummary[]>): ConfigApi {
  const states = new Map<string, State>()
  const stateOf = (): State => {
    const sp = current()
    if (!sp) throw new MockApiError(404, '空间不存在')
    let st = states.get(sp.detail.id)
    if (!st) { st = initialState(sp); states.set(sp.detail.id, st) }
    return st
  }
  const need = (reason: string | undefined) => (reason?.trim() ? undefined : fail(400, 'reason 必须是非空字符串'))
  const record = (st: State, key: string, snapshot: unknown, summary: string, reason: string) => {
    const list = st.revisions.get(key) ?? []
    if (!list.length) list.push({ rev: hash(['base', key]), author: { type: 'system', id: 'space-settings' }, reason: '记录修改前的内容', summary: '初始版本', at: new Date(Date.now() - 86_400_000).toISOString(), snapshot: undefined })
    list.unshift({ rev: hash([key, snapshot, list.length]), parent: list[0]?.rev, author: { type: 'human', id: 'wayne', via: 'web' }, reason, summary, at: new Date().toISOString(), snapshot: clone(snapshot) })
    st.revisions.set(key, list)
  }
  async function flows(st: State): Promise<WorkflowSummary[]> {
    const base = (await workflows()).filter((w) => !st.deletedWorkflows.has(w.id))
    return [...base, ...st.extraWorkflows].map((w) => ({ ...w, title: st.titles.get(w.id) ?? w.title }))
  }
  async function view(st: State): Promise<SpaceSettings> {
    const list = await flows(st)
    const usedBy = (role: string) => list.filter((w) => role !== 'automation' || w.id !== 'quick-fix').slice(0, role === 'judge' ? 1 : 2).map((w) => ({ workflow: w.id, node: role }))
    const roles = [...st.roles.values()].map((r) => ({ ...r, hash: hash(r), usedBy: usedBy(r.role) }))
    const def = st.config.defaultWorkflow ?? list[0]?.id
    return {
      config: st.config,
      roles,
      skills: [...st.skills.values()].map((s) => ({ ...s, hash: hash(s), usedBy: roles.filter((r) => r.skills.includes(s.name)).map((r) => r.role) })),
      knowledgeKinds: KNOWLEDGE_KINDS,
      templates: TEMPLATES,
      workflows: list.map((w) => ({ id: w.id, title: w.title, file: w.file, default: w.id === def, registered: true })),
      layout: { legacy: list.length === 0, issues: list.length === 0 ? ['空间里还没有任何流程'] : [] },
    }
  }

  return {
    settings: async () => delay(await view(stateOf())),
    updateConfig: async (patch, reason) => {
      const bad = need(reason); if (bad) return bad
      const st = stateOf()
      const next = clone(st.config) as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(patch)) {
        if (!['autonomy', 'defaultWorkflow', 'environment', 'selftest', 'budget', 'knowledge'].includes(k)) return fail(400, `不能通过设置页修改 ${k}`)
        if (v === null) delete next[k]; else next[k] = clone(v)
      }
      if (next.environment && !(next.environment as { deploy?: string }).deploy) return fail(400, 'environment.deploy 必须是非空命令')
      record(st, 'config:', st.config, '修改运行策略', reason)
      st.config = { ...(next as unknown as SpaceConfigSettings), knowledge: (next.knowledge as SpaceConfigSettings['knowledge'] | undefined) ?? [] }
      return delay(await view(st), 200)
    },
    saveRole: async (role, body) => {
      const bad = need(body.reason); if (bad) return bad
      const st = stateOf()
      const existing = st.roles.get(role)
      if (body.create && existing) return fail(409, `角色已存在：${role}`)
      if (!body.create && !existing) return fail(404, `角色不存在：${role}`)
      if (body.baseHash && existing && body.baseHash !== hash(existing)) return fail(409, '角色在你编辑期间被修改过，请刷新后再保存', { code: 'TAKT_STALE' })
      const base = existing ?? (body.copyFrom ? st.roles.get(body.copyFrom) : undefined)
      const next = { role, title: role, description: '', harness: { harness: 'claude-code' }, skills: [], writeScope: [], instructions: '', file: `agents/${role}.md`, ...clone(base ?? {}), ...(body.create ? { role, file: `agents/${role}.md` } : {}) } as Omit<SpaceRoleSettings, 'usedBy' | 'hash'>
      const p = body.profile
      if (p.title !== undefined) next.title = p.title
      if (p.description !== undefined) next.description = p.description
      if (p.skills !== undefined) {
        const missing = p.skills.filter((s) => !st.skills.has(s))
        if (missing.length) return fail(400, `技能不存在：${missing.join('、')}`)
        next.skills = p.skills
      }
      if (p.writeScope !== undefined) next.writeScope = p.writeScope
      if (p.readScope !== undefined) { if (p.readScope === null) delete next.readScope; else next.readScope = p.readScope }
      if (p.model !== undefined) next.harness = { ...next.harness, model: p.model || undefined }
      if (body.instructions !== undefined) next.instructions = body.instructions
      record(st, `agent:${role}`, existing, body.create ? `新建角色 ${role}` : `修改角色 ${role}`, body.reason)
      st.roles.set(role, next)
      return delay((await view(st)).roles.find((r) => r.role === role)!, 200)
    },
    deleteRole: async (role, reason) => {
      const bad = need(reason); if (bad) return bad
      const st = stateOf()
      const r = (await view(st)).roles.find((x) => x.role === role)
      if (!r) return fail(404, `角色不存在：${role}`)
      if (role === 'lead') return fail(409, 'lead 角色由宿主使用，不能删除')
      if (r.usedBy.length) return fail(409, `角色 ${role} 正被流程使用：${r.usedBy.map((u) => `${u.workflow}/${u.node}`).join('、')}`, { code: 'TAKT_IN_USE', references: r.usedBy })
      st.roles.delete(role)
      return delay({ role, deleted: true as const })
    },
    saveSkill: async (name, body) => {
      const bad = need(body.reason); if (bad) return bad
      const st = stateOf()
      const existing = st.skills.get(name)
      if (body.create && existing) return fail(409, `技能已存在：${name}`)
      if (!body.create && !existing) return fail(404, `技能不存在：${name}`)
      record(st, `skill:${name}`, existing, body.create ? `新建技能 ${name}` : `修改技能 ${name}`, body.reason)
      st.skills.set(name, { name, description: body.description, body: body.body ?? existing?.body ?? '', file: `skills/${name}/SKILL.md` })
      return delay((await view(st)).skills.find((s) => s.name === name)!, 200)
    },
    deleteSkill: async (name, reason) => {
      const bad = need(reason); if (bad) return bad
      const st = stateOf()
      const s = (await view(st)).skills.find((x) => x.name === name)
      if (!s) return fail(404, `技能不存在：${name}`)
      if (s.usedBy.length) return fail(409, `技能 ${name} 正被角色使用：${s.usedBy.join('、')}`, { code: 'TAKT_IN_USE', references: s.usedBy })
      st.skills.delete(name)
      return delay({ name, deleted: true as const })
    },
    fileRevisions: async (kind, name) => delay((stateOf().revisions.get(`${kind}:${name ?? ''}`) ?? []).map(({ snapshot: _s, ...r }) => r), 80),
    rollbackFile: async (kind, name, rev, reason) => {
      const bad = need(reason); if (bad) return bad
      const st = stateOf()
      const key = `${kind}:${name ?? ''}`
      const target = st.revisions.get(key)?.find((r) => r.rev === rev)
      if (!target) return fail(404, '修订不存在')
      const previous = st.revisions.get(key)!.find((r) => r.parent === rev)
      const snapshot = previous?.snapshot ?? target.snapshot
      if (kind === 'config' && snapshot) st.config = clone(snapshot) as SpaceConfigSettings
      if (kind === 'agent' && snapshot) st.roles.set(name!, clone(snapshot) as never)
      if (kind === 'skill' && snapshot) st.skills.set(name!, clone(snapshot) as never)
      return delay({ kind, name: name ?? 'takt.config', rev })
    },
    createWorkflow: async (body) => {
      const bad = need(body.reason); if (bad) return bad
      const st = stateOf()
      if ((await flows(st)).some((w) => w.id === body.id)) return fail(409, `workflow 已存在：${body.id}`)
      const from = 'template' in body.from ? TEMPLATES.find((t) => t.id === (body.from as { template: string }).template)?.title : (await flows(st)).find((w) => w.id === (body.from as { workflow: string }).workflow)?.title
      st.extraWorkflows.push({ id: body.id, title: body.title ?? from ?? body.id, file: `workflows/${body.id}.workflow.ts`, rev: hash(body), editable: true, updatedAt: new Date().toISOString(), nodes: 6, runs: 0 })
      return delay({ id: body.id, file: `workflows/${body.id}.workflow.ts` }, 300)
    },
    updateWorkflowMeta: async (id, body) => {
      const bad = need(body.reason); if (bad) return bad
      const st = stateOf()
      if (!(await flows(st)).some((w) => w.id === id)) return fail(404, `workflow 不存在：${id}`)
      if (body.title) st.titles.set(id, body.title)
      if (body.default) st.config = { ...st.config, defaultWorkflow: id }
      return delay(await view(st), 200)
    },
    deleteWorkflow: async (id, reason) => {
      const bad = need(reason); if (bad) return bad
      const st = stateOf()
      const list = await flows(st)
      if (!list.some((w) => w.id === id)) return fail(404, `workflow 不存在：${id}`)
      if (list.length === 1) return fail(409, '这是空间里唯一的流程，不能删除')
      st.extraWorkflows = st.extraWorkflows.filter((w) => w.id !== id)
      st.deletedWorkflows.add(id)
      if (st.config.defaultWorkflow === id) { const { defaultWorkflow: _d, ...rest } = st.config; st.config = rest }
      return delay({ id, deleted: true as const })
    },
    upgradeSpace: async (dryRun, reason) => {
      const bad = need(reason); if (bad) return bad
      const st = stateOf()
      const list = await flows(st)
      const missing = TEMPLATES.filter((t) => !list.some((w) => w.id === t.id))
      const changes = missing.flatMap((t) => [
        { kind: 'add-file' as const, target: `workflows/${t.id}.workflow.ts`, detail: `补充流程模板 ${t.id}` },
        { kind: 'register-workflow' as const, target: t.id, detail: '登记到 takt.config.json' },
      ])
      if (!dryRun) for (const t of missing) st.extraWorkflows.push({ id: t.id, title: t.title, file: `workflows/${t.id}.workflow.ts`, rev: hash(t), editable: true, updatedAt: new Date().toISOString(), nodes: 8, runs: 0 })
      return delay({ legacy: changes.length > 0, changes, applied: !dryRun && changes.length > 0 }, 300)
    },
  }
}
