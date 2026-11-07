/**
 * 管家演示数据源（全局，不分空间）：会话、逐字流式回复（思考 → 工具卡逐个出现 → 正文逐字）、提案批准 / 拒绝 / 撤销、风险、汇报、动态。
 * 回复用确定性规则：说"风险"答风险，说"建 / 新建 + 需求"出新建需求提案，说"进度 / 处理 / 今天"答待办，其余给一段通用说明。
 */
import type { Proposal, Risk, StewardFeedItem, StewardMessage, StewardStreamEvent, StewardThread, StewardToolCall } from '@taktflow/core'
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
  proposal?: Omit<Proposal, 'id' | 'threadId' | 'createdAt' | 'createdBy' | 'hash' | 'status'>
}

const S = '/s/hello-delivery'
function plan(text: string): Plan {
  if (/风险|卡住|延期/.test(text))
    return {
      thinking: '查风险引擎当前未处理的风险，按级别排序。',
      tools: [{ tool: 'risks.list', input: { state: 'open' }, ok: true, summary: '4 条未处理风险（2 高、2 中）', ms: 26 }],
      text: '现在有 **2 条高风险**：REQ-004 系分门禁重复失败 [1]，REQ-003 的 PRD 审批等了 5 小时 [2]。另有 2 条中风险，主要是 REQ-002 预算用到 84% [3]。',
      citations: [
        { label: 'REQ-004 失败指纹', href: `${S}/run/run-20261104-0004?node=design-gate`, kind: 'risk' },
        { label: 'REQ-003 待审批', href: `${S}/attention`, kind: 'attention' },
        { label: 'REQ-002 预算', href: `${S}/req/REQ-002?tab=metrics`, kind: 'requirement' },
      ],
      suggestions: ['让 REQ-004 的 Lead 排查', '把 REQ-002 预算提到 120%'],
    }
  const m = /(?:建|新建|创建)(?:一?个)?需求[：:\s]*(.+)?/.exec(text)
  if (m) {
    const title = (m[1] ?? '新需求').replace(/[，。,.].*$/, '').trim() || '新需求'
    return {
      thinking: '先做一次路由预览，确定流程档位，再生成新建需求的提案。',
      tools: [{ tool: 'route.preview', input: { title }, ok: true, summary: '建议 T1 快速修复：只动一处前端', ms: 58 }],
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
        { tool: 'requirements.list', input: { space: 'hello-delivery' }, ok: true, summary: '7 个需求：1 已交付、4 进行中', ms: 41 },
        { tool: 'attention.list', input: { pending: true }, ok: true, summary: '3 项待你处理', ms: 17 },
      ],
      text: '有 **3 项**等你处理 [1]，最急的是 REQ-003 的 PRD 审批。进展方面，REQ-001 已交付 [2]，REQ-002 进入测试阶段。',
      citations: [
        { label: '待办', href: `${S}/attention`, kind: 'attention' },
        { label: 'REQ-001', href: `${S}/req/REQ-001`, kind: 'requirement' },
      ],
      suggestions: ['先帮我批掉 REQ-003 的 PRD', '总结一下这周的进展'],
    }
  return {
    thinking: '这个问题没有对应的查询工具，先说明能做什么。',
    tools: [],
    text: '我可以回答空间、需求、运行、待办、风险和知识库的问题，也可以替你新建需求、改 workflow、配知识库——写操作都会先给你一份提案确认。试试问"今天有什么要我处理的？"',
    suggestions: ['今天有什么要我处理的？', '有哪些风险？'],
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
