/**
 * 管家演示数据源（全局，不分空间）：会话、逐字流式回复（思考 → 工具卡逐个出现 → 正文逐字）、提案批准 / 拒绝 / 撤销、风险、汇报、动态。
 * 回复用确定性规则：说"风险"答风险，说"建 / 新建 + 需求"出新建需求提案，说"进度 / 处理 / 今天"答待办；进度、风险、待办附可视化块，其余给一段通用说明。
 */
import type { Proposal, Risk, StewardBlock, StewardFeedItem, StewardMessage, StewardStreamEvent, StewardThread, StewardToolCall } from '@taktflow/core'
import { DEFAULT_PREFS, DEFAULT_PROFILE, ME, PRODUCT_METRICS, seedDigest, seedFeed, seedMessages, seedProposals, seedRisks, seedThreads, STEWARD, SUGGESTIONS } from './mock-steward-seed'
import type { StewardSource } from './source-m4'

const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 90): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (status: number, msg: string) => Promise.reject(Object.assign(new Error(msg), { status }))
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`

interface Plan {
  thinking: string
  tools: Array<Omit<StewardToolCall, 'id'>>
  text: string
  citations?: StewardMessage['citations']
  suggestions?: string[]
  /** 正文之后追加的可视化块（docs/design/24），演示时逐块送达。 */
  blocks?: StewardBlock[]
  proposal?: Omit<Proposal, 'id' | 'threadId' | 'createdAt' | 'createdBy' | 'hash' | 'status'>
}

const S = '/s/hello-delivery'
const SPACE = 'hello-delivery'
const req = (id: string, label: string) => ({ type: 'requirement' as const, spaceId: SPACE, id, label })
const STAGE_TITLES = ['需求理解', '系分设计', '测分设计', '对齐冻结', '研发测试', '影响面', '质量报告']
/** 一条泳道：前 done 格完成，第 done+1 格为 cur 状态，其余未开始。 */
const lane = (done: number, cur?: 'running' | 'waiting' | 'failed') =>
  STAGE_TITLES.map((label, i) => ({ label, status: i < done ? ('done' as const) : i === done && cur ? cur : ('todo' as const) }))

const PROGRESS_BLOCKS: StewardBlock[] = [
  {
    type: 'stats',
    items: [
      { label: '等你', value: 3, tone: 'waiting', ref: { type: 'space', id: SPACE, label: '待办' } },
      { label: '进行中', value: 3, tone: 'running' },
      { label: '阻塞', value: 1, tone: 'failed' },
      { label: '已交付', value: 1, tone: 'success' },
    ],
  },
  {
    type: 'lanes',
    title: '交付泳道',
    rows: [
      { title: '登录页增加图形验证码', ref: req('REQ-003', 'REQ-003'), stages: lane(0, 'waiting'), note: 'PRD 审批 · 等你', tone: 'waiting' },
      { title: '优惠券过期前 24 小时提醒', ref: req('REQ-004', 'REQ-004'), stages: lane(1, 'failed'), tone: 'failed' },
      { title: '订单导出支持 CSV', ref: req('REQ-002', 'REQ-002'), stages: lane(4, 'running'), tone: 'running' },
      { title: '搜索结果关键词高亮', ref: req('REQ-005', 'REQ-005'), stages: lane(2, 'running'), tone: 'running' },
      { title: '问候语支持空名字', ref: req('REQ-001', 'REQ-001'), stages: lane(7), tone: 'success' },
    ],
  },
  {
    type: 'actions',
    items: [
      { kind: 'open', label: '去审批 REQ-003', ref: req('REQ-003', 'REQ-003'), primary: true },
      { kind: 'ask', label: '为什么阻塞？', text: 'REQ-004 为什么阻塞？' },
    ],
  },
]
const RISK_BLOCKS: StewardBlock[] = [
  {
    type: 'table',
    title: '未处理风险',
    columns: [
      { key: 'level', label: '级别' },
      { key: 'req', label: '需求', mono: true },
      { key: 'risk', label: '风险' },
    ],
    rows: [
      { level: '高', req: 'REQ-004', risk: '系分门禁重复失败' },
      { level: '高', req: 'REQ-003', risk: 'PRD 审批等了 5 小时' },
      { level: '中', req: 'REQ-002', risk: '预算用到 84%' },
      { level: '中', req: 'REQ-005', risk: '评审轮次超出常值' },
    ],
    refs: [req('REQ-004', 'REQ-004'), req('REQ-003', 'REQ-003'), req('REQ-002', 'REQ-002'), req('REQ-005', 'REQ-005')],
  },
  {
    type: 'bars',
    title: '预算用量',
    unit: '%',
    items: [
      { label: 'REQ-002', value: 84, max: 100, tone: 'waiting' },
      { label: 'REQ-004', value: 61, max: 100 },
      { label: 'REQ-005', value: 38, max: 100 },
      { label: 'REQ-003', value: 12, max: 100 },
    ],
  },
  {
    type: 'actions',
    items: [
      { kind: 'ask', label: '让 Lead 排查 REQ-004', text: '让 REQ-004 的 Lead 排查门禁失败', primary: true },
      { kind: 'open', label: '看 REQ-002 用量', ref: req('REQ-002', 'REQ-002') },
    ],
  },
]
const ATTENTION_BLOCKS: StewardBlock[] = [
  {
    type: 'checklist',
    title: '等你决定',
    items: [
      { label: 'REQ-003 PRD 审批', done: false, hint: '已等 5 小时 · 审批', ref: req('REQ-003', 'REQ-003') },
      { label: 'REQ-002 测试方案确认', done: false, hint: '研发测试 · 选择', ref: req('REQ-002', 'REQ-002') },
      { label: 'REQ-005 验收口径', done: false, hint: '系分设计 · 回答', ref: req('REQ-005', 'REQ-005') },
      { label: 'REQ-001 上线确认', done: true, hint: '昨天已批准', ref: req('REQ-001', 'REQ-001') },
    ],
  },
  {
    type: 'timeline',
    title: '今天',
    items: [
      { at: '10:42', title: 'REQ-002 进入研发测试', tone: 'running' },
      { at: '09:15', title: 'REQ-004 系分门禁第 3 次失败', detail: '同一失败指纹', tone: 'failed' },
      { at: '08:30', title: 'REQ-003 PRD 提交审批', tone: 'waiting' },
    ],
  },
]

function plan(text: string): Plan {
  if (/风险|卡住|延期/.test(text))
    return {
      thinking: '查风险引擎当前未处理的风险，按级别排序。',
      tools: [{ tool: 'list_risks', input: { spaceId: 'hello-delivery' }, ok: true, summary: '风险：返回 4 条', ms: 26 }],
      text: '有 **2 条高风险**，最急的是 REQ-004 门禁反复失败 [1]；REQ-003 审批已等 5 小时 [2]，REQ-002 预算接近上限 [3]。',
      citations: [
        { label: 'REQ-004 失败指纹', href: `${S}/run/run-20261104-0004?node=design-gate`, kind: 'risk' },
        { label: 'REQ-003 待审批', href: `${S}/attention`, kind: 'attention' },
        { label: 'REQ-002 预算', href: `${S}/req/REQ-002?tab=metrics`, kind: 'requirement' },
      ],
      suggestions: ['怎么处理门禁失败？', '预算还够吗？'],
      blocks: RISK_BLOCKS,
    }
  const m = /(?:建|新建|创建)(?:一?个)?需求[：:\s]*(.+)?/.exec(text)
  if (m) {
    const title = (m[1] ?? '新需求').replace(/[，。,.].*$/, '').trim() || '新需求'
    return {
      thinking: '先做一次路由预览，确定流程档位，再生成新建需求的提案。',
      tools: [{ tool: 'propose', input: { title: `新建需求「${title}」` }, ok: true, summary: '生成提案：返回 1 条', ms: 58 }],
      text: `我准备在 hello-delivery 新建需求 **${title}** [1]，路由建议走快速修复。确认后创建，默认不启动。`,
      citations: [{ label: '路由预览', href: `${S}/requirements`, kind: 'requirement' }],
      suggestions: ['顺便补全验收标准'],
      proposal: { title: `新建需求「${title}」`, summary: '草稿，不启动；描述写入 inputs/prd.md。', risk: 'low', steps: [{ kind: 'command', spaceId: 'hello-delivery', commandId: 'requirement.create', input: { title, start: false }, title: '新建需求（草稿）' }], previews: [{ kind: 'form', title: 'requirement.create', body: JSON.stringify({ title, start: false }) }] },
    }
  }
  if (/进度|处理|今天|这周|待办/.test(text))
    return {
      thinking: '查需求阶段与待办；数字以工具结果为准。',
      tools: [
        { tool: 'list_requirements', input: { spaceId: 'hello-delivery' }, ok: true, summary: '需求列表：返回 7 条', ms: 41 },
        { tool: 'list_attention', input: { spaceId: 'hello-delivery' }, ok: true, summary: '待办：返回 3 条', ms: 17 },
      ],
      text: /待办|处理/.test(text) ? '有 **3 项**等你决定 [1]，最急的是 REQ-003 的 PRD 审批。' : '整体正常：1 条已交付 [2]，3 条在推进，REQ-004 卡在系分门禁，REQ-003 等你审批 [1]。',
      citations: [
        { label: '待办', href: `${S}/attention`, kind: 'attention' },
        { label: 'REQ-001', href: `${S}/req/REQ-001`, kind: 'requirement' },
      ],
      suggestions: ['先批 REQ-003', '这周进展总结'],
      blocks: /待办|处理/.test(text) ? ATTENTION_BLOCKS : PROGRESS_BLOCKS,
    }
  return {
    thinking: '这个问题没有对应的查询工具，先说明能做什么。',
    tools: [],
    text: '我能查进度、风险、待办和知识库，也能新建需求、改流水线——改动都先出提案，你确认后才执行。',
    suggestions: ['今天要处理什么？', '有什么风险？'],
  }
}

export function createMockSteward(): StewardSource {
  const threads = seedThreads()
  const messages = seedMessages()
  const proposals = seedProposals()
  const risks = seedRisks()
  const digest = seedDigest(risks)
  const feed = seedFeed(digest, risks, proposals)
  let prefs = clone(DEFAULT_PREFS)
  let profile = DEFAULT_PROFILE
  let unread = 3
  const threadSubs = new Map<string, Set<(e: StewardStreamEvent) => void>>()
  const feedSubs = new Set<(i: StewardFeedItem) => void>()
  const emit = (threadId: string, e: StewardStreamEvent) => threadSubs.get(threadId)?.forEach((f) => f(clone(e)))
  const pushFeed = (item: StewardFeedItem) => {
    feed.unshift(item)
    feedSubs.forEach((f) => f(clone(item)))
  }
  const bumpUnread = (d: number) => {
    unread = Math.max(0, unread + d)
    pushFeed({ type: 'unread', at: now(), count: unread })
  }
  const touch = (threadId: string, last: string) => {
    const t = threads.find((x) => x.id === threadId)
    if (t) Object.assign(t, { updatedAt: now(), lastMessage: last.replace(/\*\*|\[\d+\]/g, '').slice(0, 60) })
  }

  /** 逐步生成管家回复：message(streaming) → thinking → 工具卡逐个出现 → 正文逐字 → 提案 → done。 */
  async function reply(threadId: string, userText: string) {
    await sleep(420)
    const p = plan(userText)
    const msg: StewardMessage = { id: nid('m'), threadId, role: 'steward', at: now(), author: STEWARD, text: '', status: 'streaming', tools: [], citations: p.citations, suggestions: undefined }
    messages.push(msg)
    emit(threadId, { type: 'message', message: msg })
    await sleep(260)
    msg.thinking = p.thinking
    emit(threadId, { type: 'thinking', messageId: msg.id, text: p.thinking })
    for (const t of p.tools) {
      await sleep(520)
      const running: StewardToolCall = { id: nid('t'), tool: t.tool, input: t.input }
      msg.tools!.push(running)
      emit(threadId, { type: 'tool', messageId: msg.id, tool: running })
      await sleep(Math.max(240, (t.ms ?? 40) * 6))
      Object.assign(running, t)
      emit(threadId, { type: 'tool', messageId: msg.id, tool: running })
    }
    await sleep(240)
    for (let i = 0; i < p.text.length; i += 2) {
      const chunk = p.text.slice(i, i + 2)
      msg.text += chunk
      emit(threadId, { type: 'delta', messageId: msg.id, text: chunk })
      await sleep(26)
    }
    // 可视化块逐块送达：每次发全量，界面按序号"组装"入场
    for (let i = 1; i <= (p.blocks?.length ?? 0); i++) {
      await sleep(i === 1 ? 160 : 90)
      msg.blocks = clone(p.blocks!.slice(0, i))
      emit(threadId, { type: 'blocks', messageId: msg.id, blocks: msg.blocks })
    }
    if (p.proposal) {
      const pr: Proposal = { ...clone(p.proposal), id: nid('pr'), threadId, hash: `sha256:${Math.random().toString(16).slice(2, 12)}`, status: 'pending', createdAt: now(), createdBy: STEWARD }
      proposals.push(pr)
      msg.proposalIds = [pr.id]
      emit(threadId, { type: 'proposal', proposal: pr })
      const t = threads.find((x) => x.id === threadId)
      if (t) t.pendingProposals = (t.pendingProposals ?? 0) + 1
    }
    msg.suggestions = p.suggestions
    msg.status = 'done'
    emit(threadId, { type: 'message', message: msg })
    emit(threadId, { type: 'done', messageId: msg.id })
    touch(threadId, msg.text)
  }

  const findProposal = (id: string) => proposals.find((x) => x.id === id)
  const decide = (pr: Proposal, patch: Partial<Proposal>) => {
    Object.assign(pr, patch, { decidedBy: ME, decidedAt: now() })
    const t = threads.find((x) => x.id === pr.threadId)
    if (t) t.pendingProposals = proposals.filter((x) => x.threadId === t.id && x.status === 'pending').length
    pushFeed({ type: 'proposal', at: now(), proposal: clone(pr) })
    return delay(pr, 380)
  }

  return {
    stewardThreads: () => delay([...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
    async createStewardThread(body) {
      const thread: StewardThread = { id: nid('th'), title: body.text.slice(0, 24), createdAt: now(), updatedAt: now(), context: body.context, lastMessage: body.text }
      threads.unshift(thread)
      const message: StewardMessage = { id: nid('m'), threadId: thread.id, role: 'user', at: now(), author: ME, text: body.text, context: body.context }
      messages.push(message)
      void reply(thread.id, body.text)
      return delay({ thread, message }, 120)
    },
    stewardThread(id) {
      const thread = threads.find((t) => t.id === id)
      if (!thread) return fail(404, `会话 ${id} 不存在`)
      return delay({ thread, messages: messages.filter((m) => m.threadId === id), proposals: proposals.filter((p) => p.threadId === id) }, 120)
    },
    postStewardMessage(threadId, body) {
      if (!threads.some((t) => t.id === threadId)) return fail(404, `会话 ${threadId} 不存在`)
      const message: StewardMessage = { id: nid('m'), threadId, role: 'user', at: now(), author: ME, text: body.text, context: body.context }
      messages.push(message)
      touch(threadId, body.text)
      void reply(threadId, body.text)
      return delay(message, 80)
    },
    subscribeSteward(threadId, on) {
      let set = threadSubs.get(threadId)
      if (!set) threadSubs.set(threadId, (set = new Set()))
      set.add(on)
      return () => set!.delete(on)
    },
    stewardFeedback(messageId, body) {
      const m = messages.find((x) => x.id === messageId)
      if (!m) return fail(404, `消息 ${messageId} 不存在`)
      m.feedback = { rating: body.rating, reason: body.reason, at: now() }
      return delay(m)
    },
    proposals: (status) => delay(proposals.filter((p) => !status || p.status === status)),
    approveProposal(id, body) {
      const pr = findProposal(id)
      if (!pr) return fail(404, `提案 ${id} 不存在`)
      if (pr.status !== 'pending') return fail(409, `提案已是 ${pr.status}`)
      if (body.hash !== pr.hash && !body.steps) return (pr.status = 'stale'), fail(409, '提案内容或基线已变化，请让管家重新生成')
      return decide(pr, { status: 'applied', edited: !!body.steps, steps: body.steps ?? pr.steps, reason: body.reason, results: pr.steps.map((s) => ({ ok: true, message: `已执行：${s.title ?? s.kind}` })), undoUntil: new Date(Date.now() + 24 * 3600_000).toISOString() })
    },
    rejectProposal(id, reason) {
      const pr = findProposal(id)
      if (!pr) return fail(404, `提案 ${id} 不存在`)
      return decide(pr, { status: 'rejected', reason })
    },
    undoProposal(id, reason) {
      const pr = findProposal(id)
      if (!pr) return fail(404, `提案 ${id} 不存在`)
      if (pr.status !== 'applied' || (pr.undoUntil && Date.parse(pr.undoUntil) < Date.now())) return fail(409, '已超过可撤销时间，或目标已被他人修改')
      return decide(pr, { status: 'reverted', reason })
    },
    risks: (opts = {}) => delay(risks.filter((r) => (!opts.space || r.spaceId === opts.space) && (!opts.state || r.state === opts.state))),
    setRiskState(key, body) {
      const r = risks.find((x) => x.key === key)
      if (!r) return fail(404, `风险 ${key} 不存在`)
      Object.assign(r, { state: body.state, snoozedUntil: body.state === 'snoozed' ? (body.until ?? new Date(Date.now() + 3 * 3600_000).toISOString()) : undefined } satisfies Partial<Risk>)
      return delay(r)
    },
    digest: (_since, opts) => {
      if (!opts?.peek) bumpUnread(-unread)
      return delay(digest, 140)
    },
    stewardFeed: () => delay(feed, 100),
    subscribeStewardFeed(on) {
      feedSubs.add(on)
      return () => feedSubs.delete(on)
    },
    stewardPrefs: () => delay(prefs),
    saveStewardPrefs: (next) => ((prefs = clone(next)), delay(prefs, 200)),
    stewardProfile: () => delay({ content: profile }),
    saveStewardProfile: (content) => ((profile = content), delay({ content }, 200)),
    // 页名与服务端一致：知识库详情是 knowledge + id，设置页是 settings-<tab>
    stewardSuggestions: ({ page, id }) => delay(SUGGESTIONS[page === 'knowledge' && id ? 'knowledge-detail' : page.startsWith('settings-') ? 'settings' : page] ?? [], 60),
    productMetrics: () => delay(PRODUCT_METRICS, 160),
    async reportProductEvent(e) {
      if (e.type === 'digest.open') bumpUnread(-unread)
    },
  }
}
