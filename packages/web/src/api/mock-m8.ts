/**
 * M8 演示数据：角色结构化读写、自动化与通知渠道（docs/design/30 §3、§4）。
 * 角色以空间的档案文件（MockSpace.files 的 agent:<role>）为准，读写都落回那份 Markdown，"切到源码"看到的是同一份。
 */
import type { AgentRoleView, AgentRoleWrite, AutomationConfig, AutomationDelivery, AutomationRunRecord, AutomationsView, AutomationView, ChannelConfig, ChannelView, HarnessSelector, RuntimeConfig, SecretSource } from '@taktflow/core'
import { nextCron, parseCron } from '../lib/cron'
import type { MockSpace } from './mock-space'
import type { WorkflowApi } from './mock-workflows'
import { RoleConflictError, type M8Source } from './source-m8'
import { createMockSkills } from './mock-skills'

const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 140): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (msg: string, ms = 140): Promise<never> => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()

// ---------------------------------------------------------------- 角色档案（最小 YAML：标量与字符串列表）

type Front = Record<string, string | string[] | boolean>

function parseProfile(text: string): { front: Front; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { front: {}, body: text }
  const front: Front = {}
  let list: string | undefined
  for (const line of m[1]!.split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && list) {
      ;(front[list] as string[]).push(item[1]!.trim())
      continue
    }
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (!kv) continue
    const [, k, v] = kv as unknown as [string, string, string]
    if (v === '') {
      front[k] = []
      list = k
    } else {
      list = undefined
      front[k] = v === 'true' ? true : v === 'false' ? false : v.startsWith('[') ? v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean) : v
    }
  }
  return { front, body: m[2]!.replace(/^\n/, '') }
}

function writeProfile(front: Front, body: string): string {
  const lines = Object.entries(front).map(([k, v]) => (Array.isArray(v) ? (v.length ? `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}` : `${k}: []`) : `${k}: ${v}`))
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`
}

const hashOf = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

const harnessOf = (f: Front): HarnessSelector | undefined =>
  typeof f.harness === 'string' ? { harness: f.harness, ...(typeof f.model === 'string' ? { model: f.model } : {}), ...(typeof f.effort === 'string' ? { effort: f.effort as HarnessSelector['effort'] } : {}) } : undefined
const list = (v: Front[string] | undefined) => (Array.isArray(v) ? v : undefined)

/** 插件里带的角色（空间里没有档案时也能看到，第一次保存会在空间建一份）。 */
const PLUGIN_ROLES: Record<string, string> = {
  'security-reviewer': writeProfile({ role: 'security-reviewer', title: '安全评审', description: '按 OWASP 清单评审改动，标出高危项', skills: [], writeScope: ['reports/security-*.md'] }, '只看本次改动触达的入口：鉴权、输入校验、密钥与日志脱敏。每个问题写严重程度和修法。'),
}

interface Ctx {
  withSpace: <T>(fn: (sp: MockSpace) => T | Promise<T>) => Promise<T>
  workflowsOf: (sp: MockSpace) => WorkflowApi
  runtimeConfig: () => Promise<RuntimeConfig>
}

interface Auto {
  automations: AutomationConfig[]
  channels: ChannelConfig[]
  runs: AutomationRunRecord[]
  /** 本机密钥库里有的名字（演示）。 */
  secrets: Set<string>
}

function seedAuto(seeded: boolean, spaceId: string): Auto {
  if (!seeded) return { automations: [], channels: [], runs: [], secrets: new Set() }
  const channels: ChannelConfig[] = [
    { id: 'team-feishu', title: '交付群', kind: 'feishu', urlEnv: 'TAKT_FEISHU_DELIVERY', secretEnv: 'TAKT_FEISHU_DELIVERY_SECRET' },
    { id: 'oncall-slack', title: 'oncall', kind: 'slack', urlEnv: 'TAKT_SLACK_ONCALL' },
  ]
  const automations: AutomationConfig[] = [
    { id: 'daily-digest', title: '每日进展', enabled: true, trigger: { schedule: '30 18 * * 1-5' }, action: { kind: 'digest' }, notify: { channels: ['team-feishu'] } },
    { id: 'run-failed', title: '运行失败告警', enabled: true, trigger: { event: 'run.failed' }, action: { kind: 'notify', text: '{{requirement.title}} 的运行 {{run.id}} 失败了：{{link}}' }, notify: { channels: ['team-feishu', 'oncall-slack'] } },
    { id: 'overdue', title: '等人超时提醒', enabled: false, trigger: { event: 'attention.overdue' }, action: { kind: 'notify', text: '{{requirement.title}} 在等人决定（节点 {{node.id}}），已超时：{{link}}' }, notify: { channels: ['team-feishu'] } },
  ]
  const link = (p: string) => `http://localhost:4870/s/${spaceId}${p}`
  const digest = `hello-delivery 今日进展\nREQ-001 问候语支持空名字：已交付\nREQ-002 订单导出支持 CSV：研发 → 测试\nREQ-006 用户头像裁剪与压缩：新建\n等你：REQ-003 PRD 审批、REQ-004 是否继续重试\n${link('/attention')}`
  const runs: AutomationRunRecord[] = [
    { id: 'ar-5', automationId: 'run-failed', at: ago(95), trigger: 'event', event: { type: 'run.failed', runId: 'run-0a91', requirementId: 'REQ-004' }, status: 'failed', summary: '部分渠道发送失败，请检查发送回执后重试', error: '部分渠道发送失败', text: `优惠券过期前 24 小时提醒 的运行 run-0a91 失败了：${link('/run/run-0a91')}`, deliveries: [{ channel: 'team-feishu', ok: true, status: 200, at: ago(95) }, { channel: 'oncall-slack', ok: false, status: 404, error: '渠道返回 HTTP 404，请检查渠道配置后重试', at: ago(95) }], durationMs: 2380 },
    { id: 'ar-4', automationId: 'daily-digest', at: ago(60 * 24 - 30), trigger: 'schedule', status: 'ok', summary: '已推送 3 个需求的进展', text: digest, deliveries: [{ channel: 'team-feishu', ok: true, status: 200, at: ago(60 * 24 - 30) }], durationMs: 820 },
    { id: 'ar-3', automationId: 'daily-digest', at: ago(60 * 48 - 30), trigger: 'schedule', status: 'skipped', summary: '这段时间没有变化，没发消息', deliveries: [], durationMs: 140 },
    { id: 'ar-2', automationId: 'daily-digest', at: ago(60 * 72 - 30), trigger: 'schedule', status: 'failed', summary: '执行失败：飞书返回失败：sign match fail or timestamp is not within one hour from current time，请检查机器人配置', error: '飞书返回失败：sign match fail', deliveries: [{ channel: 'team-feishu', ok: false, status: 200, error: '飞书返回失败：sign match fail or timestamp is not within one hour from current time，请检查机器人配置', at: ago(60 * 72 - 30) }], durationMs: 2210 },
  ]
  return { automations, channels, runs, secrets: new Set(['TAKT_FEISHU_DELIVERY', 'TAKT_FEISHU_DELIVERY_SECRET']) }
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const ROLE_ID = /^[a-z][a-z0-9-]{0,39}$/

export function createMockM8({ withSpace, workflowsOf, runtimeConfig }: Ctx): { api: M8Source; rememberSecret: (name: string) => Promise<void> } {
  const autos = new Map<string, Auto>()
  const auto = (sp: MockSpace) => {
    let a = autos.get(sp.detail.id)
    if (!a) autos.set(sp.detail.id, (a = seedAuto(sp.seeded, sp.detail.id)))
    return a
  }
  const needReason = (reason?: string) => (reason?.trim() ? undefined : fail('reason 必须是非空字符串'))

  // ------------------------------------------------------------ 角色
  /** 扫一遍 workflow，按角色归集用到它的节点（一次请求只扫一次）。 */
  async function usage(sp: MockSpace): Promise<Map<string, AgentRoleView['usedBy']>> {
    const api = workflowsOf(sp)
    const out = new Map<string, AgentRoleView['usedBy']>()
    const docs = await Promise.all((await api.workflows()).map(async (w) => ({ w, doc: await api.workflow(w.id).catch(() => undefined) })))
    for (const { w, doc } of docs) {
      const walk = (nodes: unknown[] | undefined) => {
        for (const n of nodes ?? []) {
          const node = n as { id: string; props?: Record<string, { kind: string; value?: unknown }>; body?: unknown[] }
          const r = node.props?.role
          if (r?.kind === 'literal' && typeof r.value === 'string') {
            const h = node.props?.harness
            const list = out.get(r.value) ?? []
            list.push({ workflowId: w.id, workflowTitle: w.title, nodeId: node.id, ...(h?.kind === 'literal' && h.value ? { harness: h.value as HarnessSelector } : {}) })
            out.set(r.value, list)
          }
          walk(node.body)
        }
      }
      walk(doc?.model.nodes as unknown[] | undefined)
    }
    return out
  }

  async function view(sp: MockSpace, role: string, used?: Map<string, AgentRoleView['usedBy']>, cfg?: RuntimeConfig): Promise<AgentRoleView | undefined> {
    const own = sp.files.get(`agent:${role}`)
    const text = own ?? PLUGIN_ROLES[role]
    if (text === undefined) return undefined
    const { front, body } = parseProfile(text)
    const harness = harnessOf(front)
    cfg ??= await runtimeConfig().catch(() => undefined)
    const routed = cfg?.roles[role]
    const effective: AgentRoleView['effective'] = harness ? { harness, source: 'role' } : routed ? { harness: routed, source: 'space-default' } : { harness: { harness: 'native' }, source: 'builtin' }
    const skills = list(front.skills) ?? []
    const knowledge = list(front.knowledge)
    const problems = [
      ...skills.filter((s) => !sp.detail.skills.some((x) => x.name === s)).map((s) => `技能 ${s} 不存在：在"技能"里新建，或从档案里去掉`),
      ...(knowledge ?? []).filter((k) => !sp.detail.knowledge.some((x) => x.id === k)).map((k) => `知识库 ${k} 没有绑定到这个空间`),
    ]
    return {
      role,
      title: typeof front.title === 'string' ? front.title : role,
      description: typeof front.description === 'string' ? front.description : '',
      ...(own !== undefined ? { path: `agents/${role}.md` } : {}),
      origin: own !== undefined ? 'space' : 'plugin',
      revision: hashOf(text),
      ...(harness ? { harness } : {}),
      effective,
      skills,
      ...(knowledge ? { knowledge } : {}),
      writeScope: list(front.writeScope) ?? [],
      ...(list(front.readScope) ? { readScope: list(front.readScope) } : {}),
      ...(typeof front.allowBash === 'boolean' ? { allowBash: front.allowBash } : {}),
      instructions: body,
      usedBy: (used ?? (await usage(sp))).get(role) ?? [],
      ...(problems.length ? { problems } : {}),
    }
  }

  const roleIds = (sp: MockSpace) => [...new Set([...sp.detail.agents.map((a) => a.role), ...Object.keys(PLUGIN_ROLES)])]

  // ------------------------------------------------------------ 自动化
  const source = (a: Auto, name?: string): SecretSource => (!name ? 'missing' : a.secrets.has(name) ? 'local' : 'missing')
  const automationView = (sp: MockSpace, x: AutomationConfig): AutomationView => {
    const a = auto(sp)
    const problems: string[] = []
    if ('schedule' in x.trigger) {
      try {
        parseCron(x.trigger.schedule)
      } catch (e) {
        problems.push(`cron ${(e as Error).message}`)
      }
    }
    for (const c of x.notify?.channels ?? []) {
      const ch = a.channels.find((y) => y.id === c)
      if (!ch) problems.push(`渠道 ${c} 不存在：在"通知渠道"里添加，或从这里去掉`)
      else if (source(a, ch.urlEnv) === 'missing') problems.push(`渠道 ${ch.title ?? ch.id} 还没有地址（${ch.urlEnv}）`)
    }
    const next = x.enabled && 'schedule' in x.trigger && !problems.length ? nextCron(x.trigger.schedule) : undefined
    const lastRun = a.runs.find((r) => r.automationId === x.id)
    return { ...clone(x), ...(next ? { nextAt: next.toISOString() } : {}), ...(lastRun ? { lastRun: clone(lastRun) } : {}), ...(problems.length ? { problems } : {}) }
  }
  const channelView = (a: Auto, c: ChannelConfig): ChannelView => ({
    ...clone(c),
    url: source(a, c.urlEnv),
    ...(c.secretEnv ? { secret: source(a, c.secretEnv) } : {}),
    usedBy: a.automations.filter((x) => x.notify?.channels.includes(c.id)).map((x) => x.id),
  })

  /** 演示执行：digest / notify 按渠道发，地址缺失或 oncall-slack（演示 404）失败；start_workflow 起一个假运行。 */
  function execute(sp: MockSpace, x: AutomationConfig, trigger: AutomationRunRecord['trigger'], retryOf?: AutomationRunRecord): AutomationRunRecord {
    const a = auto(sp)
    const at = new Date().toISOString()
    const text = x.action.kind === 'notify' ? x.action.text.replace(/\{\{[^}]+\}\}/g, (m) => (m === '{{link}}' ? `http://localhost:4870/s/${sp.detail.id}/attention` : '')) : x.action.kind === 'digest' ? `${sp.detail.name} 进展汇报\nREQ-002 订单导出支持 CSV：测试中\n等你：REQ-003 PRD 审批` : undefined
    const deliveries = (x.notify?.channels ?? []).map((id) => {
      const ch = a.channels.find((c) => c.id === id)
      const ok = !!ch && source(a, ch.urlEnv) !== 'missing' && id !== 'oncall-slack'
      return ok ? { channel: id, ok, status: 200, at } : { channel: id, ok, ...(ch && source(a, ch.urlEnv) !== 'missing' ? { status: 404, error: '渠道返回 HTTP 404，请检查渠道配置后重试' } : { error: '渠道地址或签名密钥缺失，请配置环境变量或本机密钥库' }), at }
    })
    const failed = deliveries.some((d) => !d.ok)
    const rec: AutomationRunRecord = {
      id: `ar-${Date.now().toString(36)}`,
      automationId: x.id,
      at,
      trigger,
      ...(retryOf?.event ? { event: clone(retryOf.event) } : {}),
      status: failed ? 'failed' : 'ok',
      summary: failed ? '部分渠道发送失败，请检查发送回执后重试' : x.action.kind === 'start_workflow' ? `已启动 ${x.action.workflowId}` : x.action.kind === 'digest' ? '已推送 2 个需求的进展' : '已发送',
      ...(failed ? { error: '部分渠道发送失败' } : {}),
      ...(x.action.kind === 'start_workflow' ? { runId: `run-${Date.now().toString(36).slice(-4)}` } : {}),
      ...(text ? { text } : {}),
      deliveries,
      ...(retryOf ? { retryOf: retryOf.id } : {}),
      durationMs: 600 + Math.round(Math.random() * 900),
    }
    a.runs.unshift(rec)
    return rec
  }

  const api: M8Source = {
    ...createMockSkills(withSpace),
    agentRoles: () =>
      withSpace(async (sp) => {
        const [used, cfg] = await Promise.all([usage(sp), runtimeConfig().catch(() => undefined)])
        const out: AgentRoleView[] = []
        for (const r of roleIds(sp)) {
          const v = await view(sp, r, used, cfg)
          if (v) out.push(v)
        }
        return delay(out)
      }),
    agentRole: (role) =>
      withSpace(async (sp) => {
        const v = await view(sp, role)
        return v ? delay(v) : fail(`角色 ${role} 不存在`)
      }),
    saveAgentRole: (role, w: AgentRoleWrite) =>
      needReason(w.reason) ??
      withSpace(async (sp) => {
        if (!ROLE_ID.test(role)) return fail('角色 id 只能用小写字母开头，后面是小写字母、数字和 -，最长 40 个字符')
        const key = `agent:${role}`
        const text = sp.files.get(key) ?? PLUGIN_ROLES[role]
        if (text !== undefined && w.baseRevision && w.baseRevision !== hashOf(text)) return Promise.reject(new RoleConflictError())
        const { front, body } = text !== undefined ? parseProfile(text) : { front: { role } as Front, body: '' }
        const bad = [...(w.writeScope ?? []), ...(w.readScope ?? [])].find((g) => g.startsWith('/') || g.includes('..'))
        if (bad) return fail(`写范围 / 读范围要用相对路径 glob：${bad} 不行`)
        const missing = (w.skills ?? []).find((s) => !sp.detail.skills.some((x) => x.name === s))
        if (missing) return fail(`skills：技能 ${missing} 不存在`)
        const set = (k: string, v: string | string[] | boolean | null | undefined) => {
          if (v === null) delete front[k]
          else if (v !== undefined) front[k] = v
        }
        set('title', w.title)
        set('description', w.description)
        if (w.harness !== undefined) {
          for (const k of ['harness', 'model', 'effort']) delete front[k]
          if (w.harness) {
            front.harness = w.harness.harness
            if (w.harness.model) front.model = w.harness.model
            if (w.harness.effort) front.effort = w.harness.effort
          }
        }
        set('skills', w.skills)
        set('knowledge', w.knowledge)
        set('writeScope', w.writeScope)
        set('readScope', w.readScope)
        set('allowBash', w.allowBash)
        const next = writeProfile(front, w.instructions ?? body)
        sp.files.set(key, next)
        const rec = { role, title: (front.title as string) ?? role, description: (front.description as string) ?? '', harness: harnessOf(front) ?? { harness: 'native' }, writeScope: list(front.writeScope) ?? [] }
        const i = sp.detail.agents.findIndex((a) => a.role === role)
        if (i >= 0) sp.detail.agents[i] = rec
        else sp.detail.agents.push(rec)
        return delay((await view(sp, role))!, 220)
      }),
    deleteAgentRole: (role, reason) =>
      needReason(reason) ??
      withSpace(async (sp) => {
        if (!sp.files.has(`agent:${role}`)) return fail('只能删空间里的角色档案；插件 / 内置角色不能删')
        const used = (await usage(sp)).get(role) ?? []
        if (used.length) return fail(`还有 ${used.length} 个节点用这个角色：${used.map((u) => `${u.workflowId}/${u.nodeId}`).join('、')}。先改掉这些节点再删`)
        sp.files.delete(`agent:${role}`)
        sp.detail.agents = sp.detail.agents.filter((a) => a.role !== role)
        return delay(undefined, 160)
      }),

    automations: () =>
      withSpace((sp) => {
        const a = auto(sp)
        const view: AutomationsView = { automations: a.automations.map((x) => automationView(sp, x)), channels: a.channels.map((c) => channelView(a, c)), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        return delay(view)
      }),
    saveAutomation: (x, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const a = auto(sp)
        if (!ID.test(x.id)) return fail('id 只能用小写字母、数字和 -，最长 40 个字符')
        if (!x.title.trim()) return fail('title：名字不能为空')
        if ('schedule' in x.trigger) {
          try {
            parseCron(x.trigger.schedule)
          } catch (e) {
            return fail(`trigger.schedule：${(e as Error).message}`)
          }
          if (x.action.kind === 'start_workflow' && !x.action.requirementId) return fail('action.requirementId：定时启动 workflow 要指定需求')
        }
        if (x.action.kind !== 'start_workflow' && !x.notify?.channels.length) return fail('notify.channels：汇报和发消息至少要选一个渠道')
        const unknown = x.notify?.channels.find((c) => !a.channels.some((y) => y.id === c))
        if (unknown) return fail(`notify.channels：渠道 ${unknown} 不存在`)
        const i = a.automations.findIndex((y) => y.id === x.id)
        if (i >= 0) a.automations[i] = clone(x)
        else a.automations.push(clone(x))
        return delay(automationView(sp, x), 200)
      }),
    deleteAutomation: (id, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const a = auto(sp)
        a.automations = a.automations.filter((x) => x.id !== id)
        return delay(undefined, 140)
      }),
    triggerAutomation: (id, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const x = auto(sp).automations.find((y) => y.id === id)
        return x ? delay(execute(sp, x, 'manual'), 900) : fail('自动化不存在，请刷新列表')
      }),
    automationRuns: (id) => withSpace((sp) => delay(auto(sp).runs.filter((r) => r.automationId === id).slice(0, 20), 120)),
    retryAutomationRun: (id, recordId, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const a = auto(sp)
        const x = a.automations.find((y) => y.id === id)
        const orig = a.runs.find((r) => r.id === recordId)
        if (!x) return fail('自动化不存在，请刷新列表')
        if (!orig || orig.status !== 'failed') return fail('只有 failed 记录可以重试，请刷新执行记录')
        return delay(execute(sp, x, 'retry', orig), 900)
      }),
    saveChannel: (c, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const a = auto(sp)
        if (!ID.test(c.id)) return fail('id 只能用小写字母、数字和 -，最长 40 个字符')
        if (!/^[A-Z_][A-Z0-9_]*$/.test(c.urlEnv)) return fail('urlEnv：环境变量名只能用大写字母、数字和 _')
        const i = a.channels.findIndex((y) => y.id === c.id)
        if (i >= 0) a.channels[i] = clone(c)
        else a.channels.push(clone(c))
        return delay(channelView(a, c), 180)
      }),
    deleteChannel: (id, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const a = auto(sp)
        const used = a.automations.filter((x) => x.notify?.channels.includes(id))
        if (used.length) return fail(`还有自动化在用这个渠道：${used.map((x) => x.title).join('、')}。先从它们里去掉再删`)
        a.channels = a.channels.filter((c) => c.id !== id)
        return delay(undefined, 140)
      }),
    testChannel: (id, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const a = auto(sp)
        const c = a.channels.find((y) => y.id === id)
        if (!c) return fail(`渠道 ${id} 不存在`)
        const at = new Date().toISOString()
        const result = (d: AutomationDelivery, ms: number) => delay(d, ms)
        if (source(a, c.urlEnv) === 'missing') return result({ channel: id, ok: false, error: '渠道地址或签名密钥缺失，请配置环境变量或本机密钥库', at }, 600)
        if (id === 'oncall-slack') return result({ channel: id, ok: false, status: 404, error: '渠道返回 HTTP 404，请检查渠道配置后重试', at }, 1200)
        return result({ channel: id, ok: true, status: 200, at }, 800)
      }),
  }
  // 渠道表单里粘贴的地址存进本机密钥库后，渠道变为可用（真实服务端由密钥库统一判断来源）
  const rememberSecret = (name: string) => withSpace((sp) => void auto(sp).secrets.add(name))
  return { api, rememberSecret }
}
