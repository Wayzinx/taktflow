/**
 * 需求群聊演示：每个需求一个群（真人 + Lead + 临时出现的子 Agent）。
 * REQ-002 第一次被订阅时，用定时器播放一段 Lead 对话：有人 @lead → Lead 派发临时任务 → dev 实现 → reviewer 评审 → Lead 请求审批合入。
 */
import type { Actor, AttentionItem, ChatPostRequest, LeadPresence, Room, RoomMember, RoomMessage } from '@taktflow/core'
import type { MockDb } from './mock-data'
import { createTaskRun } from './mock-task-run'

const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()
const LEAD: Actor = { type: 'agent', role: 'lead', harness: 'claude-code', model: 'sonnet' }
const ENGINE: Actor = { type: 'system', id: 'engine' }
const human = (id: string): Actor => ({ type: 'human', id })
const DEV: Actor = { type: 'agent', role: 'dev', harness: 'codex', model: 'gpt-5-codex' }
const REVIEWER: Actor = { type: 'agent', role: 'reviewer', harness: 'claude-code', model: 'sonnet' }

type Draft = Omit<RoomMessage, 'id' | 'roomId' | 'seq' | 'at'> & { at?: string }

interface RoomState {
  room: Room
  messages: RoomMessage[]
  subs: Set<(m: RoomMessage) => void>
  leadSubs: Set<(p: LeadPresence) => void>
  leadTimer?: ReturnType<typeof setTimeout>
  scripted: boolean
}

/** Lead 状态灯演示：thinking → working → waiting → idle 循环（毫秒为该状态持续时长）。 */
const LEAD_CYCLE: Array<[LeadPresence['state'], number, string]> = [
  ['thinking', 3200, '正在读群消息与运行状态'],
  ['working', 7000, '正在派发任务、跟进当前节点'],
  ['waiting', 6000, '等负责人确认待办'],
  ['idle', 8000, '没有需要处理的事'],
]

export interface MockChat {
  room(id: string): Room | undefined
  addMembers(id: string, members: RoomMember[]): Room | undefined
  list(id: string, opts?: { after?: number; limit?: number }): RoomMessage[] | undefined
  post(id: string, body: ChatPostRequest, by: Actor): RoomMessage | undefined
  subscribe(id: string, on: (m: RoomMessage) => void, onLead?: (p: LeadPresence) => void): () => void
  /** 群里的待办被处理后，Lead 跟进一句。 */
  onAnswered(item: AttentionItem): void
  /** 群聊任务卡重发（只允许 uncertain / expired）：发一张新卡片，replyTo 指向原卡片。 */
  resendTask(id: string, messageId: string, reason: string): RoomMessage | string
}

export function createMockChat(db: MockDb): MockChat {
  const rooms = new Map<string, RoomState>()

  function push(st: RoomState, d: Draft): RoomMessage {
    const seq = (st.messages[st.messages.length - 1]?.seq ?? 0) + 1
    const m: RoomMessage = { ...d, id: `${st.room.id}-m${seq}`, roomId: st.room.id, seq, at: d.at ?? new Date().toISOString() }
    st.messages.push(m)
    st.subs.forEach((f) => f(structuredClone(m)))
    return m
  }

  /** 原地更新一条消息（回执推进）：订阅方按 id upsert。 */
  function update(st: RoomState, m: RoomMessage, patch: Partial<RoomMessage>) {
    Object.assign(m, patch)
    st.subs.forEach((f) => f(structuredClone(m)))
  }

  function ensure(reqId: string): RoomState | undefined {
    const hit = rooms.get(reqId)
    if (hit) return hit
    const req = db.requirements.find((r) => r.id === reqId)
    if (!req) return undefined
    const members: RoomMember[] = [
      ...(req.members ?? [req.owner ?? 'web']).map((id): RoomMember => ({ id, kind: 'human', name: id, role: id === req.owner ? '负责人' : '成员' })),
      { id: 'lead', kind: 'lead', name: 'Lead', role: '项目经理 · 调度' },
    ]
    const st: RoomState = { room: { id: `room-${reqId}`, requirementId: reqId, title: `${reqId} ${req.title}`, members, createdAt: req.createdAt, lead: { state: 'idle', since: new Date().toISOString(), detail: LEAD_CYCLE[3]![2] } }, messages: [], subs: new Set(), leadSubs: new Set(), scripted: false }
    rooms.set(reqId, st)
    seed(st, reqId)
    return st
  }

  function seed(st: RoomState, reqId: string) {
    const names = st.room.members.filter((m) => m.kind === 'human').map((m) => m.name).join('、')
    push(st, { author: ENGINE, at: st.room.createdAt, kind: 'system', text: `需求群已创建，成员：${names}、Lead` })
    push(st, { author: LEAD, at: st.room.createdAt, kind: 'text', text: '我是这个需求的 Lead：盯进度、派任务、找人审批，不直接写代码。@lead 问进度或提要求都可以。' })
    const items = db.attention.filter((a) => a.requirementId === reqId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    // 路由卡：每次流水线运行开始时 Lead 发一张（docs/design/19 §1）
    for (const run of [...db.runs.values()].filter((r) => r.state.requirementId === reqId && r.state.route).sort((a, b) => Date.parse(a.state.startedAt) - Date.parse(b.state.startedAt))) {
      const r = run.state.route!
      push(st, { author: LEAD, at: r.at, kind: 'route', text: `按 ${r.tier} 走「${run.workflow.title}」：${r.reason}`, route: r, refs: { runId: run.state.runId } })
    }
    if (reqId === 'REQ-002') {
      const env = items.find((a) => a.requestId === 'att-0002-env')
      push(st, { author: ENGINE, at: ago(140), kind: 'system', text: '进入「研发测试 Loop」阶段', refs: { runId: 'run-20261104-0002' } })
      if (env) {
        push(st, { author: ENGINE, at: env.createdAt, kind: 'attention', text: env.ask, refs: { requestId: env.requestId, runId: env.runId, nodeId: env.nodeId } })
        push(st, { author: human('chen'), at: env.answeredAt, kind: 'text', text: '测试库导好了，2000 条订单，TC-EXP-008 可以重跑了。' })
      }
      push(st, { author: LEAD, at: ago(31), kind: 'progress', text: '研发测试 Loop 第 2 轮：8 条用例 6 条通过。TC-EXP-003（金额格式）和 TC-EXP-005（大数据量导出）仍判为产品缺陷，已路由回 fix-code。', refs: { runId: 'run-20261104-0002', artifacts: [{ workspace: reqId, path: 'evidence/summary.json' }] } })
      push(st, { author: human('qiao'), at: ago(23), kind: 'text', text: 'TC-EXP-005 是不是要等分片方案？设计里写的是 2000 行一片。', refs: { artifacts: [{ workspace: reqId, path: 'design/design.md' }] } })
      push(st, { author: LEAD, at: ago(22), kind: 'text', mentions: ['qiao'], text: '对，design/design.md 第 3 节已经定了分片方案，fix-code 这一轮会按它实现。@qiao 想改分片大小的话直接在群里说，我来发起修改。' })
      push(st, { author: LEAD, at: ago(20), kind: 'text', mentions: ['lin'], text: 'TC-EXP-003 的金额格式问题定位到 csv.ts:42，fix-code 已改好。**待确认** @lin 确认合入 fix-code 的改动 **下一步** 合入后重跑 TC-EXP-003 与 TC-EXP-005', refs: { runId: 'run-20261104-0002', nodeId: 'fix-code' } })
      // 回执的两种异常（docs/design/26 §4）：派发时出错、可能已送达；跳数超过上限被拒绝
      push(st, { author: LEAD, at: ago(16), kind: 'text', mentions: ['dev'], text: 'TC-EXP-006 是脚本的等待条件写死了 500ms，我派给 @dev 改成等进度条出现。' })
      push(st, { author: LEAD, at: ago(16), kind: 'task', text: '修正 TC-EXP-006 的等待条件', receipt: { status: 'uncertain', hops: 0, note: '派发时服务重启，没收到"任务已创建"的确认，任务可能已经在跑。' } })
      push(st, { author: LEAD, at: ago(9), kind: 'task', text: '再补一轮导出性能压测（10 万行）', receipt: { status: 'refused', hops: 4, chain: ['task-m3k2a1', 'task-m3k4c7', 'task-m3k9f2'], note: '超过派发跳数上限（本空间设为 3）：上一轮压测任务的产出又派了任务，已经是第 4 跳。停下来等人看要不要继续。' } })
      return
    }
    for (const a of items) push(st, { author: ENGINE, at: a.createdAt, kind: 'attention', text: a.ask, refs: { requestId: a.requestId, runId: a.runId, nodeId: a.nodeId } })
  }

  /** REQ-002 的演示脚本：时间点是第一次订阅后的毫秒数。 */
  function play(st: RoomState) {
    st.scripted = true
    const reqId = st.room.requirementId
    const runId = `task-${Date.now().toString(36)}`
    let task: ReturnType<typeof createTaskRun> | undefined
    let taskMsg: RoomMessage | undefined
    const steps: Array<[number, () => void]> = [
      [2600, () => push(st, { author: human('lin'), kind: 'text', mentions: ['lead'], text: '@lead 金额两位小数这个能不能先单独修？周五要给运营演示导出。' })],
      [5200, () => push(st, { author: LEAD, kind: 'text', mentions: ['dev', 'reviewer'], text: '可以单独修。我派一个临时任务给 @dev：只改 shop-api 的 src/export/csv.ts，金额统一走 formatAmount(value, 2) 并补单测，写权限收窄到 src/export/**；改完由 @reviewer 评审一轮。', refs: { artifacts: [{ workspace: reqId, path: 'cases/TC-EXP-003.json' }, { workspace: reqId, path: 'design/contracts.json' }] } })],
      [10400, () => {
        task = createTaskRun(db, {
          runId, requirementId: reqId, title: '金额字段统一保留两位小数', by: LEAD,
          worktree: { repo: 'shop-api', branch: 'task/fix-amount-format', base: 'main' },
          nodes: [
            { id: 'implement', kind: 'agent', title: '修正金额格式化', role: 'dev', harness: 'codex', model: 'gpt-5-codex', prompt: 'src/export/csv.ts 的金额字段改用 formatAmount(value, 2)，补单测。写权限：src/export/**、test/export/**。' },
            { id: 'review', kind: 'review', title: '代码评审', role: 'reviewer', harness: 'claude-code', model: 'sonnet', prompt: '按 money-format 技能评审改动，给结论和问题清单。' },
          ],
        })
        addMembers(reqId, [{ id: 'dev', kind: 'agent', name: 'dev', role: '研发 · codex' }, { id: 'reviewer', kind: 'agent', name: 'reviewer', role: '代码评审 · claude-code' }])
        taskMsg = push(st, { author: LEAD, kind: 'task', text: '金额字段统一保留两位小数', refs: { taskRunId: runId, runId }, receipt: { status: 'sent', hops: 0 } })
      }],
      [11000, () => taskMsg && update(st, taskMsg, { receipt: { status: 'taken', hops: 0 } })],
      [11600, () => {
        task?.start('implement')
        if (taskMsg) update(st, taskMsg, { receipt: { status: 'started', hops: 0 } })
      }],
      [17800, () => {
        task?.finish('implement', 'succeeded', [], { inputTokens: 18_420, outputTokens: 2_310, cachedTokens: 9_800, costUsd: 0.046 })
        push(st, { author: DEV, kind: 'text', text: '改好了：csv.ts:42 改用 formatAmount(value, 2)，stream.ts 里同样的写法也一起换了；新增 3 条单测，本地 12/12 通过。', refs: { taskRunId: runId, nodeId: 'implement' } })
        task?.start('review')
      }],
      [24200, () => {
        const path = 'reports/review-fix-amount.md'
        addReviewReport(reqId, runId, path)
        task?.finish('review', 'succeeded', [{ workspace: reqId, path, version: 1 }], { inputTokens: 9_610, outputTokens: 880, cachedTokens: 4_200, costUsd: 0.041 })
        task?.end('succeeded')
        if (taskMsg) update(st, taskMsg, { receipt: { status: 'done', hops: 0 } })
        push(st, { author: REVIEWER, kind: 'text', text: '评审通过，92 分。1 条建议：把舍入方式写进 money-format 技能的示例里，免得下次再踩。', refs: { taskRunId: runId, nodeId: 'review', artifacts: [{ workspace: reqId, path, version: 1 }] } })
      }],
      [25600, () => push(st, { author: ENGINE, kind: 'system', text: '临时任务完成：金额字段统一保留两位小数（评审 1 轮通过）', refs: { taskRunId: runId } })],
      [27400, () => push(st, { author: LEAD, kind: 'text', mentions: ['lin'], text: '任务完成，补丁在分支 task/fix-amount-format。合进当前 Loop 并重跑 TC-EXP-003 需要审批，@lin 看一下。' })],
      [31200, () => {
        const item: AttentionItem = { requestId: `att-${runId}-merge`, runId, nodeId: 'review', requirementId: reqId, ask: '把临时任务的补丁（task/fix-amount-format）合入当前研发测试 Loop，并重跑 TC-EXP-003？', form: 'approve', createdAt: new Date().toISOString() }
        db.attention.push(item)
        push(st, { author: LEAD, kind: 'attention', text: item.ask, refs: { requestId: item.requestId, runId, nodeId: 'review' } })
      }],
    ]
    for (const [ms, fn] of steps) setTimeout(fn, ms)
  }

  function addReviewReport(reqId: string, runId: string, path: string) {
    const content = '# 评审 · 金额字段统一保留两位小数\n\n结论：**通过**（92 分）\n\n| 严重程度 | 位置 | 问题 | 建议 |\n|---|---|---|---|\n| 建议 | skills/money-format/SKILL.md | 示例里没有舍入方式 | 补一个 12.345 → 12.34 的 half-even 示例 |\n'
    const list = db.artifacts.get(reqId) ?? []
    list.push({ path, kind: 'review', title: '评审 · 金额格式修正', mediaType: 'text/markdown', tags: ['临时任务'], traceIds: ['TC-EXP-003'], versions: [{ version: 1, sha256: 'b'.repeat(64), size: content.length, createdAt: new Date().toISOString(), author: REVIEWER, reason: '代码评审', derivedFrom: [], producedBy: { runId, nodeId: 'review' } }] })
    db.artifacts.set(reqId, list)
    db.contents.set(`${reqId}:${path}@1`, { content, mediaType: 'text/markdown' })
  }

  function leadReply(reqId: string): string {
    const pending = db.attention.filter((a) => a.requirementId === reqId && !a.answeredAt).length
    const runs = [...db.runs.values()].filter((r) => r.state.requirementId === reqId && r.state.workflowId !== 'task')
    const latest = runs.sort((a, b) => Date.parse(b.state.startedAt) - Date.parse(a.state.startedAt))[0]
    const running = latest?.graph.nodes.filter((n) => n.status === 'running').map((n) => n.title) ?? []
    const now = running.length ? `正在跑：${running.join('、')}。` : latest ? '流水线这会儿没有在跑的节点。' : '还没有启动过流水线。'
    return `收到。${now}${pending ? `等人处理的事有 ${pending} 件，群里的待办卡片可以直接处理。` : '目前没有等人处理的事。'}要改产物或代码的话，我会派临时任务给对应角色，结果回帖到这里。`
  }

  function cycleLead(st: RoomState, i: number) {
    const [state, ms, detail] = LEAD_CYCLE[i % LEAD_CYCLE.length]!
    st.room.lead = { state, since: new Date().toISOString(), detail }
    st.leadSubs.forEach((f) => f(structuredClone(st.room.lead!)))
    st.leadTimer = setTimeout(() => cycleLead(st, i + 1), ms)
  }

  function addMembers(id: string, members: RoomMember[]) {
    const st = ensure(id)
    if (!st) return undefined
    for (const m of members) if (!st.room.members.some((x) => x.id === m.id)) st.room.members.push(m)
    return st.room
  }

  return {
    room: (id) => ensure(id)?.room,
    addMembers,
    list(id, opts = {}) {
      const st = ensure(id)
      if (!st) return undefined
      const after = st.messages.filter((m) => m.seq > (opts.after ?? 0))
      return opts.limit ? after.slice(-opts.limit) : after
    },
    post(id, body, by) {
      const st = ensure(id)
      if (!st) return undefined
      const mentions = body.mentions ?? st.room.members.filter((m) => body.text.includes(`@${m.id}`)).map((m) => m.id)
      const m = push(st, { author: by, kind: 'text', text: body.text, mentions, replyTo: body.replyTo })
      if (mentions.includes('lead')) setTimeout(() => push(st, { author: LEAD, kind: 'text', text: leadReply(id), replyTo: m.id, mentions: by.type === 'human' ? [by.id] : undefined }), 1800)
      return m
    },
    subscribe(id, on, onLead) {
      const st = ensure(id)
      if (!st) return () => {}
      st.subs.add(on)
      if (onLead) {
        st.leadSubs.add(onLead)
        if (!st.leadTimer) cycleLead(st, 0)
      }
      if (id === 'REQ-002' && !st.scripted) play(st)
      return () => {
        st.subs.delete(on)
        if (onLead) st.leadSubs.delete(onLead)
        if (!st.leadSubs.size && st.leadTimer) {
          clearTimeout(st.leadTimer)
          st.leadTimer = undefined
        }
      }
    },
    resendTask(id, messageId, reason) {
      const st = ensure(id)
      const m = st?.messages.find((x) => x.id === messageId)
      if (!st || !m || m.kind !== 'task') return `任务消息 ${messageId} 不存在`
      if (!reason.trim()) return '需要写原因'
      const status = m.receipt?.status
      if (status !== 'uncertain' && status !== 'expired') return '只有"不确定"或"已过期"的任务可以重发'
      if (st.messages.some((x) => x.kind === 'task' && x.replyTo === messageId)) return '这个任务已经重发过了，看下面的新卡片'
      const next = push(st, { author: LEAD, kind: 'task', text: m.text, replyTo: m.id, receipt: { status: 'sent', hops: m.receipt?.hops, chain: m.receipt?.chain, note: `人工重发：${reason.trim()}` } })
      setTimeout(() => update(st, next, { receipt: { ...next.receipt!, status: 'taken' } }), 1600)
      return next
    },
    onAnswered(item) {
      const st = rooms.get(item.requirementId)
      if (!st || !st.messages.some((m) => m.refs?.requestId === item.requestId)) return
      const ok = item.decision !== 'reject'
      setTimeout(() => push(st, { author: LEAD, kind: 'text', text: ok ? '好，已经按审批结果继续：补丁合入当前 Loop，TC-EXP-003 重跑中，结果出来我再回帖。' : '收到，这次不合入。补丁分支保留，需要的时候再说。' }), 1400)
    },
  }
}
