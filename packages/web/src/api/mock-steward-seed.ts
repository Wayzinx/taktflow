/**
 * 管家演示数据（docs/design/22 §1）：3 个会话、提案、5 条风险、一份汇报、8 项产品健康指标、动态。
 * 业务与 mock-data.ts 一致：hello-delivery 空间的 REQ-001…REQ-007。
 */
import { lit } from './workflow-edit'
import type { Actor, Digest, ProductMetric, Proposal, Risk, StewardFeedItem, StewardMessage, StewardPrefs, StewardThread } from '@taktflow/core'

const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()
const later = (min: number) => new Date(Date.now() + min * MIN).toISOString()
export const STEWARD: Actor = { type: 'agent', role: 'steward', harness: 'native', model: 'claude-sonnet-4.5' }
export const ME: Actor = { type: 'human', id: 'wayne' }
const S = '/s/hello-delivery'

export function seedThreads(): StewardThread[] {
  return [
    { id: 'th-weekly', title: '这周交付进度和风险', createdAt: ago(46), updatedAt: ago(6), context: [{ type: 'space', id: 'hello-delivery', label: 'hello-delivery' }], lastMessage: '已经帮你建了 REQ-008；workflow 的改动等你确认。', pendingProposals: 1 },
    { id: 'th-kb', title: '给 hello-delivery 建一个文档知识库', createdAt: ago(26 * 60), updatedAt: ago(25 * 60), context: [{ type: 'knowledge', spaceId: 'hello-delivery', id: 'shop-docs', label: '商城文档' }], lastMessage: '构建完成，Recall@10 为 0.86，可以发布了。' },
    { id: 'th-req4', title: 'REQ-004 为什么卡住了', createdAt: ago(3 * 24 * 60), updatedAt: ago(3 * 24 * 60 - 8), context: [{ type: 'requirement', spaceId: 'hello-delivery', id: 'REQ-004', label: 'REQ-004 优惠券过期提醒' }], lastMessage: '系分门禁同一个失败指纹出现了 2 次，已暂停自动重试。' },
  ]
}

export function seedMessages(): StewardMessage[] {
  return [
    { id: 'm-w1', threadId: 'th-weekly', role: 'user', at: ago(46), author: ME, text: '这周交付情况怎么样？有什么要我处理的？', context: [{ type: 'space', id: 'hello-delivery', label: 'hello-delivery' }] },
    {
      id: 'm-w2',
      threadId: 'th-weekly',
      role: 'steward',
      at: ago(45),
      author: STEWARD,
      status: 'done',
      thinking: '先查空间里所有需求的阶段与待办，再看风险引擎的结果；数字都以工具结果为准。',
      tools: [
        { id: 't1', tool: 'list_requirements', input: { spaceId: 'hello-delivery' }, ok: true, summary: '需求列表：返回 7 条', ms: 42, output: { total: 7, delivered: 1, active: 4, blocked: 1, draft: 1 } },
        { id: 't2', tool: 'list_attention', input: { spaceId: 'hello-delivery' }, ok: true, summary: '待办：返回 3 条', ms: 18, output: [{ id: 'att-3', requirementId: 'REQ-003', ask: 'PRD 审批' }] },
        { id: 't3', tool: 'list_risks', input: { spaceId: 'hello-delivery' }, ok: true, summary: '风险：返回 4 条', ms: 25 },
      ],
      text: '这周 **1 个需求已交付**（REQ-001）[1]，4 个在跑。要你处理的有 3 项，最急的是 REQ-003 的 PRD 审批，已经等了 5 小时 [2]。\n\n风险方面：REQ-004 的系分门禁连续两次同一个失败指纹，已被暂停 [3]；REQ-002 预算用到 84% [4]。\n\n预算的事我转给了 REQ-002 的 Lead，但发送时连接断了，不确定送到没有。另外按你上周说的，我把"测试之后加一道交叉评审"做成了 workflow 提案，等你确认。',
      delegations: [{ spaceId: 'hello-delivery', requirementId: 'REQ-002', messageId: 'chat-steward-2', status: 'uncertain', at: ago(44) }],
      citations: [
        { label: 'REQ-001 已交付', href: `${S}/req/REQ-001`, kind: 'requirement' },
        { label: 'REQ-003 待审批', href: `${S}/attention`, kind: 'attention' },
        { label: 'REQ-004 失败指纹', href: `${S}/run/run-20261104-0004?node=review-design`, kind: 'run' },
        { label: 'REQ-002 预算 84%', href: `${S}/req/REQ-002?tab=metrics`, kind: 'requirement' },
      ],
      proposalIds: ['pr-review'],
      suggestions: ['先帮我批掉 REQ-003 的 PRD', 'REQ-004 要怎么解开？', '把 REQ-002 的预算提到 120%'],
    },
    { id: 'm-w3', threadId: 'th-weekly', role: 'user', at: ago(8), author: ME, text: '再帮我建个需求：购物车支持批量删除，草稿就行，先别启动。' },
    {
      id: 'm-w4',
      threadId: 'th-weekly',
      role: 'steward',
      at: ago(6),
      author: STEWARD,
      status: 'done',
      tools: [{ id: 't4', tool: 'propose', input: { title: '新建需求「购物车支持批量删除」' }, ok: true, summary: '生成提案：返回 1 条', ms: 63 }],
      text: '已经帮你建了 **REQ-008 购物车支持批量删除**（草稿，未启动）[1]。路由预览建议走快速修复（T1）[2]，启动时可以再改。',
      citations: [
        { label: 'REQ-008', href: `${S}/req/REQ-008`, kind: 'requirement' },
        { label: '路由预览', href: `${S}/req/REQ-008?tab=chat`, kind: 'requirement' },
      ],
      proposalIds: ['pr-req8'],
      suggestions: ['帮 REQ-008 补全验收标准', '现在启动 REQ-008'],
    },
    { id: 'm-k1', threadId: 'th-kb', role: 'user', at: ago(26 * 60), author: ME, text: '帮我从 shop-docs 仓库的 docs/ 建一个文档知识库' },
    { id: 'm-k2', threadId: 'th-kb', role: 'steward', at: ago(25 * 60), author: STEWARD, status: 'done', tools: [{ id: 't5', tool: 'knowledge_search', input: { spaceId: 'hello-delivery', text: '商城文档 构建与评测' }, ok: true, summary: '检索知识库：返回 1 条', ms: 192000 }], text: '构建完成，Recall@10 为 0.86 [1]，可以发布了。', citations: [{ label: '商城文档 · 评测', href: `${S}/knowledge/shop-docs?tab=eval`, kind: 'knowledge' }], suggestions: ['发布并绑定到 hello-delivery'] },
    { id: 'm-r1', threadId: 'th-req4', role: 'user', at: ago(3 * 24 * 60), author: ME, text: 'REQ-004 为什么卡住了？' },
    { id: 'm-r2', threadId: 'th-req4', role: 'steward', at: ago(3 * 24 * 60 - 8), author: STEWARD, status: 'done', tools: [{ id: 't6', tool: 'run_status', input: { spaceId: 'hello-delivery', runId: 'run-20261104-0004' }, ok: true, summary: '运行状态：返回 1 条', ms: 31 }], text: '系分门禁同一个失败指纹出现了 2 次 [1]，已暂停自动重试。我已经在需求群里请 Lead 看一下设计里的接口契约。', citations: [{ label: '失败指纹', href: `${S}/run/run-20261104-0004?node=design-gate`, kind: 'run' }], delegations: [{ spaceId: 'hello-delivery', requirementId: 'REQ-004', messageId: 'chat-steward-1', status: 'answered', reply: '契约里缺少过期时间的时区说明，已补上并重跑门禁。', at: ago(3 * 24 * 60 - 30) }] },
  ]
}

export function seedProposals(): Proposal[] {
  return [
    {
      id: 'pr-review',
      threadId: 'th-weekly',
      title: '在测试之后加一道交叉评审',
      summary: '最近 3 次交付里有 2 次在验收时才发现测试遗漏；在研发测试 Loop 之后加 review-test（换一家模型评审），预计每个需求多 6 分钟。',
      risk: 'medium',
      steps: [
        { kind: 'workflow', spaceId: 'hello-delivery', workflowId: 'sdlc', baseRev: 'e3b9a41c', title: '新增节点 review-test，并让影响面评估依赖它', edits: [
          { op: 'addNode', kind: 'review', props: { id: lit('review-test'), title: lit('测试交叉评审'), target: lit('dev-test-loop') }, after: 'dev-test-loop' },
          { op: 'setNeeds', id: 'impact', needs: ['review-test'] },
        ] },
        { kind: 'command', spaceId: 'hello-delivery', commandId: 'models.assign', input: { node: 'review-test', model: 'gpt-5-codex' }, title: '评审节点用另一家模型' },
      ],
      hash: 'sha256:9f2c0a71d4',
      status: 'pending',
      createdAt: ago(45),
      createdBy: STEWARD,
      previews: [
        { kind: 'diff', title: 'workflows/sdlc.workflow.ts', body: "@@ -46,10 +46,16 @@\n   n('loop', { id: 'dev-test-loop', title: '研发测试 Loop', stage: 'loop', needs: ['integration', 'review-scripts'] }, [ … ]),\n+  n('review', {\n+    id: 'review-test',\n+    title: '测试交叉评审',\n+    target: 'dev-test-loop',\n+    needs: ['dev-test-loop'],\n+  }),\n-  n('agent', { id: 'impact', title: '影响面评估', needs: ['dev-test-loop'] }),\n+  n('agent', { id: 'impact', title: '影响面评估', needs: ['review-test'] })," },
        { kind: 'form', title: 'models.assign', body: JSON.stringify({ node: 'review-test', model: 'gpt-5-codex' }) },
      ],
    },
    {
      id: 'pr-req8',
      threadId: 'th-weekly',
      title: '新建需求 REQ-008 购物车支持批量删除',
      summary: '草稿，不启动；描述写入 inputs/prd.md。',
      risk: 'low',
      steps: [{ kind: 'command', spaceId: 'hello-delivery', commandId: 'requirement.create', input: { title: '购物车支持批量删除', start: false }, title: '新建需求（草稿）' }],
      hash: 'sha256:51b77e0c2a',
      status: 'applied',
      auto: true,
      createdAt: ago(6),
      createdBy: STEWARD,
      decidedBy: ME,
      decidedAt: ago(6),
      results: [{ ok: true, message: '已创建 REQ-008' }],
      undoUntil: later(24 * 60 - 6),
      previews: [{ kind: 'text', title: 'requirement.create', body: '在 hello-delivery 新建草稿需求「购物车支持批量删除」，不启动运行。' }],
    },
  ]
}

const risk = (r: Omit<Risk, 'firstSeenAt' | 'lastSeenAt'> & { first: number; last: number }): Risk => {
  const { first, last, ...rest } = r
  return { ...rest, firstSeenAt: ago(first), lastSeenAt: ago(last) }
}

export function seedRisks(): Risk[] {
  return [
    risk({ key: 'repeat-failure:hello-delivery/REQ-004/design-gate', kind: 'repeat-failure', level: 'high', spaceId: 'hello-delivery', requirementId: 'REQ-004', runId: 'run-20261104-0004', nodeId: 'design-gate', title: 'REQ-004 系分门禁重复失败', detail: '同一失败指纹出现 2 次，自动重试已暂停。', evidence: [{ label: '失败指纹', href: `${S}/run/run-20261104-0004?node=design-gate` }], actions: [{ label: '让 Lead 排查', ask: '让 REQ-004 的 Lead 排查系分门禁失败' }, { label: '查看运行', href: `${S}/run/run-20261104-0004` }], state: 'open', first: 190, last: 12, notifiedLevel: 'high' }),
    risk({ key: 'waiting-human:hello-delivery/REQ-003/att-prd', kind: 'waiting-human', level: 'high', spaceId: 'hello-delivery', requirementId: 'REQ-003', title: 'REQ-003 PRD 审批等了 5 小时', detail: '审批对象已更新到 v2，原审批绑定的是 v1。', evidence: [{ label: '待办', href: `${S}/attention` }], actions: [{ label: '去审批', href: `${S}/attention` }], state: 'open', first: 300, last: 4, notifiedLevel: 'medium' }),
    risk({ key: 'budget:hello-delivery/REQ-002/run', kind: 'budget', level: 'medium', spaceId: 'hello-delivery', requirementId: 'REQ-002', title: 'REQ-002 预算用到 84%', detail: 'tokens 已用 84%，按当前速度会在测试阶段超出。', evidence: [{ label: '度量', href: `${S}/req/REQ-002?tab=metrics` }], actions: [{ label: '预算提到 120%', commandId: 'budget.raise', input: { requirementId: 'REQ-002', percent: 120 } }], state: 'open', first: 80, last: 20, notifiedLevel: 'medium' }),
    risk({ key: 'knowledge:hello-delivery/-/orders-db', kind: 'knowledge', level: 'medium', spaceId: 'hello-delivery', title: '订单库知识库 Recall@10 下降', detail: '最近一次评测 0.71，比上次低 0.09。', evidence: [{ label: '评测', href: `${S}/knowledge/orders-db?tab=eval` }], actions: [{ label: '重新构建', ask: '帮我重新构建订单库知识库并跑一次评测' }], state: 'snoozed', snoozedUntil: later(180), first: 26 * 60, last: 90 }),
    risk({ key: 'regression:hello-delivery/-/automate', kind: 'regression', level: 'medium', spaceId: 'hello-delivery', title: 'automate 节点疑似退化', detail: 'playwright-e2e 技能更新后通过率 87% → 50%。', evidence: [{ label: '成绩单', href: `${S}/eval?card=automate` }], actions: [{ label: '回滚技能', ask: '把 playwright-e2e 技能回滚到上一个版本' }], state: 'ignored', first: 3 * 24 * 60, last: 2 * 24 * 60 }),
  ]
}

export function seedDigest(risks: Risk[]): Digest {
  return {
    id: 'dg-1107-0930',
    at: ago(130),
    since: ago(16 * 60),
    summary: '昨晚到现在 REQ-001 已交付，REQ-002 进入测试；有 3 件事等你，其中 REQ-003 的审批最急。',
    attention: [
      { spaceId: 'hello-delivery', requirementId: 'REQ-003', requirementTitle: '登录页增加图形验证码', requestId: 'att-prd', ask: 'PRD 审批（已更新到 v2）', since: ago(300), href: `${S}/attention` },
      { spaceId: 'hello-delivery', requirementId: 'REQ-004', requirementTitle: '优惠券过期前 24 小时提醒', requestId: 'att-retry', ask: '是否继续重试系分门禁', since: ago(190), href: `${S}/attention` },
      { spaceId: 'hello-delivery', requirementId: 'REQ-002', requirementTitle: '订单导出支持 CSV', requestId: 'att-budget', ask: '预算即将用完，是否追加', since: ago(80), href: `${S}/attention` },
    ],
    risks: risks.filter((r) => r.state === 'open'),
    // 和服务端一致：每个需求只留最新一条，按时间倒序；more 是同一需求被折叠的更早条数（docs/design/30 §2）
    progress: [
      { spaceId: 'hello-delivery', requirementId: 'REQ-006', title: '用户头像裁剪与压缩', kind: 'created', at: ago(12), href: `${S}/req/REQ-006` },
      { spaceId: 'hello-delivery', requirementId: 'REQ-002', title: '订单导出支持 CSV', kind: 'stage', from: '研发', to: '测试', at: ago(3 * 60), href: `${S}/req/REQ-002`, more: 3 },
      { spaceId: 'hello-delivery', requirementId: 'REQ-004', title: '优惠券过期前 24 小时提醒', kind: 'blocked', at: ago(190), href: `${S}/req/REQ-004`, more: 1 },
      { spaceId: 'hello-delivery', requirementId: 'REQ-001', title: '问候语支持空名字', kind: 'delivered', at: ago(10 * 60), href: `${S}/req/REQ-001`, more: 5 },
    ],
    metrics: [
      { spaceId: 'hello-delivery', label: '交付周期中位数', value: '2.6 天', delta: '-0.4' },
      { spaceId: 'hello-delivery', label: '一次通过率', value: '71%', delta: '+6%' },
      { spaceId: 'hello-delivery', label: '本周花费', value: '$18.40', delta: '+$3.10' },
    ],
  }
}

const trend = (base: number, step: number) => Array.from({ length: 7 }, (_, i) => Math.round((base + step * i + (i % 2 ? step / 2 : 0)) * 100) / 100)

export const PRODUCT_METRICS: ProductMetric[] = [
  { feature: 'requirement.create', metric: '新建需求用时中位数', value: 38, unit: 's', window: '7d', trend: trend(62, -4), hint: '仍有 30% 的人手动改了路由，说明路由理由不够有说服力' },
  { feature: 'requirement.create', metric: '对话框放弃率', value: 12, unit: '%', window: '7d', trend: trend(21, -1.3), hint: '放弃多发生在"成员"标签，考虑默认带上空间成员' },
  { feature: 'steward.answer', metric: '引用覆盖率', value: 93, unit: '%', window: '7d', trend: trend(84, 1.3), hint: '无引用的句子集中在"预计完成时间"，需要一个估时工具' },
  { feature: 'steward.answer', metric: '首字延迟 P50', value: 820, unit: 'ms', window: '7d', trend: trend(1100, -40) },
  { feature: 'steward.proposal', metric: '提案通过率', value: 78, unit: '%', window: '7d', trend: trend(70, 1.1), hint: '被拒最多的是 workflow 提案（理由：改动太大），可以拆成更小的步骤' },
  { feature: 'steward.proposal', metric: '撤销率', value: 4, unit: '%', window: '7d', trend: trend(6, -0.3) },
  { feature: 'steward.digest', metric: '汇报点击率', value: 46, unit: '%', window: '7d', trend: trend(38, 1.2), hint: '18:00 的汇报点击率只有 09:30 的一半，考虑改到 17:30' },
  { feature: 'knowledge', metric: '知识库命中率', value: 81, unit: '%', window: '7d', trend: trend(77, 0.6), hint: '订单库的空结果率上升，可能是表白名单缺了新表' },
]

export function seedFeed(digest: Digest, risks: Risk[], proposals: Proposal[]): StewardFeedItem[] {
  return [
    { type: 'unread', at: ago(1), count: 3 },
    { type: 'proposal', at: ago(6), proposal: proposals[1]! },
    { type: 'risk', at: ago(12), risk: risks[0]!, change: 'escalated' },
    { type: 'proposal', at: ago(45), proposal: proposals[0]! },
    { type: 'digest', at: digest.at, digest },
    { type: 'risk', at: ago(80), risk: risks[2]!, change: 'new' },
    { type: 'delegation', at: ago(3 * 24 * 60 - 30), threadId: 'th-req4', delegation: { spaceId: 'hello-delivery', requirementId: 'REQ-004', messageId: 'chat-steward-1', status: 'answered', reply: '契约里缺少过期时间的时区说明，已补上并重跑门禁。', at: ago(3 * 24 * 60 - 30) } },
  ]
}

export const DEFAULT_PREFS: StewardPrefs = {
  trust: 'confirm',
  digestTimes: ['09:30', '18:00'],
  quietHours: { from: '22:00', to: '08:00' },
  watchedSpaces: ['hello-delivery', 'payments'],
  mutedSpaces: ['payments-legacy'],
  defaultSpace: 'hello-delivery',
  harness: { harness: 'native', model: 'claude-sonnet-4.5' },
  browserNotifications: false,
}

export const DEFAULT_PROFILE = '# 关于我\n\n- 我主要关注 hello-delivery，其次是 payments。\n- 汇报先说要我处理的事，数字给到个位就行。\n- 评审节点偏好用另一家模型交叉评审。\n'

/** 页内建议（GET /steward/suggestions?page=）：最多 3 条。 */
export const SUGGESTIONS: Record<string, string[]> = {
  overview: ['进度怎么样？', '有什么风险？', '今天要处理什么？'],
  requirements: ['进度怎么样？', '哪些卡住了？', '新建一个需求'],
  requirement: ['卡在哪了？', '补全验收标准', '什么时候交付？'],
  run: ['为什么慢？', '失败怎么修？'],
  attention: ['先处理最急的', '哪些可以一起批？'],
  workflows: ['哪条最常失败？', '新建一条流水线'],
  workflow: ['测试后加交叉评审', '评审换个模型', '检查有没有问题'],
  knowledge: ['从 docs/ 建知识库', '哪个命中率最低？'],
  'knowledge-detail': ['召回为什么下降？', '合成 20 条评测'],
  settings: ['评审换个模型', '加一个成员', '检查仓库配置'],
  eval: ['哪个节点退化了？', '跑一次回放评测'],
  spaces: ['新建项目空间', '哪里风险最多？'],
  steward: ['今天要处理什么？', '这周进展总结'],
}
