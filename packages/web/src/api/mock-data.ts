/**
 * 演示数据：一个与 hello-delivery 示例对齐的项目（REQ-001 完整跑完：7 个阶段、Loop 2 轮、1 条 product_bug 判决、
 * 1 次上下文压缩、planner 展开 2 个条目），再加 5 个处在不同阶段的需求，让总览有层次。
 * 所有时间相对页面加载时刻，"x 分钟前"始终合理。
 */
import type {
  Actor,
  ArtifactComment,
  ArtifactKind,
  ArtifactRecord,
  ArtifactRef,
  AttentionItem,
  CompactionRecord,
  ContextItem,
  ContextSnapshot,
  EventEnvelope,
  EventPayloads,
  EventType,
  GraphEdge,
  GraphNode,
  JudgeVerdict,
  NodeKind,
  NodeState,
  NodeStatus,
  PlannedItem,
  Requirement,
  RequirementMetrics,
  RunState,
  RunStatus,
  SnapshotNode,
  StageDef,
  TraceGraph,
  Usage,
  VerdictCategory,
} from '@taktflow/core'
import * as C from './mock-content'

const MIN = 60_000
export const NOW = Math.floor(Date.now() / MIN) * MIN
const iso = (ms: number) => new Date(ms).toISOString()

export const STAGES: StageDef[] = [
  { id: 'understand', title: '需求理解' },
  { id: 'design', title: '系分设计' },
  { id: 'test-design', title: '测分设计' },
  { id: 'align', title: '对齐冻结' },
  { id: 'loop', title: '研发测试 Loop' },
  { id: 'impact', title: '影响面评估' },
  { id: 'report', title: '质量报告' },
]

export const BUDGET = 32_000

// ============================================================ workflow 模板（与 templates/workflows/sdlc.workflow.ts 对齐）

interface TplNode {
  id: string
  kind: NodeKind
  title: string
  stage: string
  needs: string[]
  role?: string
  parent?: string
  prompt?: string
  inputs?: string[]
  outputs?: Array<{ path: string; kind: ArtifactKind }>
  routes?: Partial<Record<VerdictCategory, string>>
  ask?: string
  form?: AttentionItem['form']
  checks?: SnapshotNode['checks']
}

const L = 'dev-test-loop'
const P = 'implement'

const SDLC: TplNode[] = [
  {
    id: 'clarify', kind: 'agent', title: '需求澄清', stage: 'understand', needs: [], role: 'pm',
    inputs: ['inputs/**', 'decisions/**?'], outputs: [{ path: 'spec/clarify.md', kind: 'clarification' }],
    prompt: '读 inputs/ 下的 PRD、会议纪要和设计稿，列出所有会影响实现或验收的待确认问题（每条写清楚为什么要问、可选答案）。信息足够就写"无待确认问题"。',
  },
  { id: 'answer-clarify', kind: 'human', title: '回答澄清问题', stage: 'understand', needs: ['clarify'], form: 'answer', ask: '请在 spec/clarify.md 里逐条回答，或在这里写下统一答复。' },
  {
    id: 'spec', kind: 'agent', title: '编写 spec', stage: 'understand', needs: ['answer-clarify'], role: 'pm',
    inputs: ['inputs/**', 'spec/clarify.md', 'decisions/**?'], outputs: [{ path: 'spec/spec.md', kind: 'spec' }],
    prompt: '根据物料和澄清结论写 spec：背景、范围、不做什么、功能点、验收标准。每条验收标准编号为 AC-<n>，必须可验证（写清输入、操作、期望结果）。',
  },
  { id: 'review-spec', kind: 'human', title: '评审 spec', stage: 'understand', needs: ['spec'], form: 'approve', ask: '审阅 spec/spec.md：范围和验收标准是否正确、可验证？' },
  {
    id: 'design', kind: 'agent', title: '系分设计', stage: 'design', needs: ['review-spec'], role: 'architect',
    inputs: ['spec/spec.md'], outputs: [{ path: 'design/design.md', kind: 'design' }, { path: 'design/contracts.json', kind: 'contract' }],
    prompt: '基于 spec 和现有代码写系分：改动范围、模块划分、接口契约（路径、方法、入参、响应结构、错误码）、数据变更、风险。契约写进 design/contracts.json。存量能力优先复用，不要重写。',
  },
  { id: 'design-gate', kind: 'gate', title: '系分门禁', stage: 'design', needs: ['design'], checks: [{ id: 'design-rubric', kind: 'rubric', title: '系分质量评分（reviewer）', threshold: 80 }] },
  { id: 'review-design', kind: 'human', title: '评审系分', stage: 'design', needs: ['design-gate'], form: 'approve', ask: '审阅 design/：方案和契约是否可以冻结？' },
  {
    id: 'test-design', kind: 'agent', title: '测分与用例设计', stage: 'test-design', needs: ['review-design'], role: 'test-designer',
    inputs: ['spec/spec.md', 'design/contracts.json'], outputs: [{ path: 'test-plan/plan.md', kind: 'test-plan' }, { path: 'cases/*.json', kind: 'case' }],
    prompt: '按 spec 和契约设计测试：先写 test-plan/plan.md（范围、分层、数据构造、不可自动化项），再为每条用例写 cases/<CaseID>.json（id、title、covers 映射到 AC、前置、步骤、断言必须落到业务字段或终态）。不要读产品代码。',
  },
  { id: 'review-cases', kind: 'human', title: '评审用例', stage: 'test-design', needs: ['test-design'], form: 'approve', ask: '审阅 test-plan/ 和 cases/：用例是否覆盖全部验收标准、断言是否有效？' },
  { id: 'trace-gate', kind: 'gate', title: '追溯对齐', stage: 'align', needs: ['review-cases'], checks: [{ id: 'ac-covered', kind: 'function', title: '每条 AC 至少有一条用例，每条用例都映射到 AC' }] },
  { id: 'freeze', kind: 'script', title: '冻结基线', stage: 'align', needs: ['trace-gate'], outputs: [{ path: 'decisions/baseline.json', kind: 'decision' }] },
  {
    id: P, kind: 'planner', title: '拆分并实现开发任务', stage: 'loop', needs: ['freeze'], role: 'architect',
    inputs: ['spec/spec.md', 'design/**'],
    prompt: '读 spec/spec.md 和 design/，把实现拆成可独立交付的任务（每个任务半天内能完成），给出 key、title、dependsOn 和 role。',
  },
  {
    id: 'automate', kind: 'agent', title: '用例转自动化', stage: 'loop', needs: ['freeze'], role: 'automation',
    inputs: ['cases/*.json', 'design/contracts.json'],
    prompt: '把 cases/ 下每条用例实现为一个自动化脚本（一条用例一个脚本），执行后写证据到 evidence/<CaseID>/，汇总到 evidence/summary.json。断言必须对应用例里的验证点，禁止只断言状态码。',
  },
  { id: L, kind: 'loop', title: '研发测试 Loop', stage: 'loop', needs: [P, 'automate'] },
  { id: `${L}/run-cases`, kind: 'script', title: '执行用例', stage: 'loop', parent: L, needs: [], outputs: [{ path: 'evidence/summary.json', kind: 'evidence' }] },
  {
    id: `${L}/judge`, kind: 'judge', title: '失败判决', stage: 'loop', parent: L, needs: [`${L}/run-cases`], role: 'judge',
    inputs: ['evidence/**', 'cases/*.json', 'spec/spec.md', 'design/contracts.json'],
    routes: { product_bug: 'fix-code', script_defect: 'fix-script', case_defect: 'fix-case' },
    prompt: '逐条分析失败用例的证据，按"需求 > 契约 > 用例 > 脚本 > 代码"的权威顺序判定根因类别，给出置信度、理由、证据引用和修复类别。只读，不得修改任何文件。',
  },
  { id: `${L}/fix-code`, kind: 'agent', title: '修复代码', stage: 'loop', parent: L, needs: [`${L}/judge`], role: 'dev', inputs: ['reports/verdict-*.json?', 'evidence/**'], prompt: '读 judge 的判决（product_bug 部分）和对应证据，修复产品代码。不要修改测试和用例。' },
  { id: `${L}/fix-script`, kind: 'agent', title: '修复脚本', stage: 'loop', parent: L, needs: [`${L}/judge`], role: 'automation', inputs: ['evidence/**'], prompt: '读 judge 的判决（script_defect 部分），只修定位、等待、取值等机械问题；不得删除或弱化断言。' },
  { id: `${L}/fix-case`, kind: 'agent', title: '修正用例', stage: 'loop', parent: L, needs: [`${L}/judge`], role: 'test-designer', inputs: ['cases/*.json', 'spec/spec.md'], prompt: '读 judge 的判决（case_defect 部分），按 spec 修正用例，并在 decisions/case-changes.md 写明每处修改的依据。' },
  {
    id: 'impact', kind: 'agent', title: '影响面评估', stage: 'impact', needs: [L], role: 'reviewer',
    inputs: ['tasks/*.md', 'design/design.md'], outputs: [{ path: 'reports/impact.md', kind: 'report' }],
    prompt: '根据本需求的代码改动和调用链，列出可能受影响的存量功能、需要回归的范围和建议补测项。',
  },
  { id: 'quality-report', kind: 'script', title: '生成质量报告', stage: 'report', needs: ['impact'], outputs: [{ path: 'reports/quality.md', kind: 'report' }] },
  { id: 'acceptance', kind: 'human', title: '准出验收', stage: 'report', needs: ['quality-report'], form: 'approve', ask: '审阅 reports/quality.md 和 reports/impact.md，是否准出？' },
  {
    id: 'knowledge-writeback', kind: 'agent', title: '知识回流', stage: 'report', needs: ['acceptance'], role: 'pm',
    inputs: ['spec/spec.md', 'decisions/**?', 'reports/**'], outputs: [{ path: 'reports/knowledge-diff.md', kind: 'knowledge' }],
    prompt: '把本需求沉淀的业务规则、决策和踩过的坑整理成知识库的修改建议（写成 diff 形式，供人审后合入）。',
  },
]

function expandItem(item: PlannedItem): TplNode[] {
  const base = `${P}/${item.key}`
  return [
    {
      id: `${base}/code`, kind: 'agent', title: `实现：${item.title}`, stage: 'loop', parent: P, role: item.role ?? 'dev',
      needs: (item.dependsOn ?? []).map((d) => `${P}/${d}/review`),
      inputs: ['spec/spec.md', 'design/**'], outputs: [{ path: `tasks/${item.key}.md`, kind: 'task' }],
      prompt: `实现任务 ${item.key}「${item.title}」。完成后在 tasks/${item.key}.md 写改动摘要和自测结果。`,
    },
    {
      id: `${base}/review`, kind: 'agent', title: `评审：${item.title}`, stage: 'loop', parent: P, role: 'reviewer', needs: [`${base}/code`],
      inputs: [`tasks/${item.key}.md`], outputs: [{ path: `reports/review-${item.key}.md`, kind: 'review' }],
      prompt: `评审任务 ${item.key} 的代码改动：正确性、冗余、可读性、是否复用存量能力。只写评审意见，不改代码。`,
    },
  ]
}

const HARNESS: Record<string, string> = { pm: 'claude-code', architect: 'claude-code', reviewer: 'claude-code', judge: 'claude-code', dev: 'codex', automation: 'codex', 'test-designer': 'codex' }
const MODEL: Record<string, string> = { 'claude-code': 'claude-sonnet-4.5', codex: 'gpt-5-codex' }
const ROLE_TOKENS: Record<string, number> = { pm: 820, architect: 1140, reviewer: 760, judge: 1320, dev: 980, automation: 870, 'test-designer': 1050 }
const SKILLS: Record<string, [string, number]> = {
  dev: ['skills/tdd.md', 860],
  'test-designer': ['skills/case-design.md', 940],
  automation: ['skills/no-weak-assert.md', 520],
  judge: ['skills/triage-order.md', 610],
  architect: ['skills/reuse-first.md', 480],
}

// ============================================================ 工具

function fakeHash(s: string): string {
  let out = ''
  for (let k = 0; k < 8; k++) {
    let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out
}

/** 中文为主的文本：约 2.2 字符 / token。 */
const estTokens = (s: string) => Math.max(1, Math.round(s.length / 2.2))

function usage(inK: number, outK: number): Usage {
  const inputTokens = Math.round(inK * 1000)
  const outputTokens = Math.round(outK * 1000)
  const cachedTokens = Math.round(inputTokens * 0.38)
  const costUsd = ((inputTokens - cachedTokens) * 3 + cachedTokens * 0.3 + outputTokens * 15) / 1_000_000
  return { inputTokens, outputTokens, cachedTokens, costUsd }
}

export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}
export const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }

function globToRegex(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*')
  return new RegExp(`^${re}$`)
}

const human = (id: string): Actor => ({ type: 'human', id })
const agentActor = (role: string): Actor => {
  const harness = HARNESS[role] ?? 'claude-code'
  return { type: 'agent', role, harness, model: MODEL[harness] }
}
const ENGINE: Actor = { type: 'system', id: 'engine' }

// ============================================================ 产物

interface VersionSpec {
  content: string
  at: number
  author: Actor
  reason?: string
  node?: string
  runId?: string
  derivedFrom?: string[]
}
interface ArtSpec {
  path: string
  kind: ArtifactKind
  title?: string
  mediaType?: string
  tags?: string[]
  versions: VersionSpec[]
}

export interface StoredContent {
  content: string
  mediaType: string
  encoding?: 'utf8' | 'base64'
}

const TRACE_ID = /\b(?:REQ-\d+|AC-\d+|TC-[A-Z]+-\d+)\b/g

function mediaTypeOf(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  return 'text/plain'
}

function toBase64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}

function buildArtifacts(reqId: string, specs: ArtSpec[], contents: Map<string, StoredContent>): ArtifactRecord[] {
  return specs.map((s) => {
    const mediaType = s.mediaType ?? mediaTypeOf(s.path)
    const binary = mediaType.startsWith('image/')
    const versions = s.versions.map((v, i) => {
      contents.set(`${reqId}:${s.path}@${i + 1}`, binary ? { content: toBase64(v.content), mediaType, encoding: 'base64' } : { content: v.content, mediaType })
      return {
        version: i + 1,
        sha256: fakeHash(v.content),
        size: new TextEncoder().encode(v.content).length,
        createdAt: iso(v.at),
        author: v.author,
        reason: v.reason,
        derivedFrom: (v.derivedFrom ?? []).map((d) => {
          const [path, ver] = d.split('@')
          return { workspace: reqId, path: path!, version: ver ? Number(ver) : undefined }
        }),
        producedBy: v.node && v.runId ? { runId: v.runId, nodeId: v.node } : undefined,
      }
    })
    const traceIds = [...new Set(s.versions.flatMap((v) => (binary ? [] : v.content.match(TRACE_ID) ?? [])))]
    return { path: s.path, kind: s.kind, title: s.title, mediaType, tags: s.tags ?? [], traceIds, versions }
  })
}

// ============================================================ 运行计划

interface Exec {
  start: number
  end?: number
  iteration?: number
  status?: NodeStatus
  usage?: [number, number]
}
interface NodePlan {
  status: NodeStatus
  execs: Exec[]
  error?: string
}
interface RawEvent {
  ts: number
  nodeId?: string
  type: EventType
  actor: Actor
  data: unknown
}
interface RunPlan {
  runId: string
  reqId: string
  start: number
  status: RunStatus
  end?: number
  items: PlannedItem[]
  nodes: Record<string, NodePlan>
  /** 人工节点的回答（requestId 由节点生成）。 */
  answers?: Record<string, { by: string; decision?: string; answer?: string }>
  extra?: (at: (min: number) => number) => RawEvent[]
  snapshots?: Record<string, (at: (min: number) => number, base: ContextSnapshot) => { snapshots: ContextSnapshot[]; compactions: CompactionRecord[] }>
  gates?: Record<string, { pass: boolean; checks: Array<{ id: string; pass: boolean; score?: number; message?: string }> }>
  verdicts?: Record<string, Array<{ iteration: number; verdicts: JudgeVerdict[]; routed: Array<{ subject: string; to: string }> }>>
}

const ok = (start: number, end: number, u?: [number, number], iteration?: number): NodePlan => ({ status: 'succeeded', execs: [{ start, end, usage: u, iteration }] })

export interface MockRun {
  state: RunState
  workflow: { id: string; title: string; version: string; stages: StageDef[] }
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  events: EventEnvelope[]
  tpl: Map<string, TplNode>
  context: Map<string, { snapshots: ContextSnapshot[]; compactions: CompactionRecord[] }>
  prompts: Map<string, string>
  gates: RunPlan['gates']
  /** 运行中的节点：用于模拟实时 token 增长。 */
  live: string[]
}

const NARRATION: Record<string, { plan: string; tools: Array<[string, string, string?, boolean?]>; final: string }> = {
  clarify: {
    plan: '先读 PRD 和评审纪要，对照"会影响实现或验收"的标准筛问题，再写 spec/clarify.md。',
    tools: [['Read', 'inputs/prd.md', '# PRD：问候语支持空名字 …（38 行）'], ['Read', 'inputs/meeting-1103.md', '# 需求评审会纪要 · 11-03 …（11 行）'], ['Write', 'spec/clarify.md', '写入 22 行']],
    final: '整理出 3 个待确认问题，已写入 spec/clarify.md。',
  },
  spec: {
    plan: '以澄清答复为准写 spec，AC 编号从 AC-1 开始，每条写清输入和期望。',
    tools: [['Read', 'spec/clarify.md', '…答复表 3 行'], ['Write', 'spec/spec.md', '写入 31 行']],
    final: 'spec 已完成：2 条验收标准，约束 2 条。',
  },
  design: {
    plan: '先查调用链确认影响面，复用现有 greet()，契约只描述行为规则。',
    tools: [['Grep', 'greet\\(', 'cli/hello.js:4\nserver/routes/greet.js:12\ndocs/examples/basic.md:8'], ['Read', 'src/greet.js', 'export function greet(name) {\n  return `Hello, ${name}!`\n}'], ['Write', 'design/design.md', '写入 34 行'], ['Write', 'design/contracts.json', '写入 21 行']],
    final: '系分完成：单文件改动，签名不变，3 处调用方无需修改。',
  },
  'test-design': {
    plan: '黑盒设计：只读 spec 和契约，一条 AC 至少一条用例，断言落到返回值。',
    tools: [['Read', 'spec/spec.md'], ['Read', 'design/contracts.json'], ['Write', 'test-plan/plan.md', '写入 24 行'], ['Write', 'cases/TC-GREET-001.json'], ['Write', 'cases/TC-GREET-002.json']],
    final: '测试计划 + 2 条用例，覆盖 AC-1、AC-2。',
  },
  [P]: {
    plan: '按"可独立交付、半天内完成"拆分；常量先行，空名字分支依赖常量。',
    tools: [['Read', 'spec/spec.md'], ['Read', 'design/design.md']],
    final: '拆出 2 个任务：greet-core → greet-empty。',
  },
  automate: {
    plan: '仓库里已有 tests/run-cases.mjs 按 cases/*.json 驱动，确认断言与用例一致即可。',
    tools: [['Read', 'tests/run-cases.mjs', '… 46 行'], ['Bash', 'node tests/run-cases.mjs --dry-run', 'cases 2 · ready', true]],
    final: '脚本已就绪：执行器读取 cases/*.json，证据写入 evidence/<CaseID>/。',
  },
  code: {
    plan: '按任务说明改 src/greet.js，改完跑一遍相关用例自测。',
    tools: [['Read', 'src/greet.js'], ['Edit', 'src/greet.js', '+3 −1'], ['Bash', 'npm test -- --grep GREET', 'passed 1 · failed 1', false], ['Write', 'tasks/<key>.md']],
    final: '改动完成，自测结果已写入任务摘要。',
  },
  review: {
    plan: '对照 spec 约束检查改动：正确性、冗余、是否复用。',
    tools: [['Read', 'tasks/<key>.md'], ['Bash', 'git diff --stat', ' src/greet.js | 4 +++-'], ['Write', 'reports/review-<key>.md']],
    final: '评审完成，无阻塞问题。',
  },
  judge: {
    plan: '读失败用例的证据，按"需求 > 契约 > 用例 > 脚本 > 代码"顺序判定根因。',
    tools: [['Read', 'evidence/TC-GREET-002/result.json', '{ "expected": "Hello, stranger!", "actual": "Hello, !" }'], ['Read', 'spec/spec.md#AC-2'], ['Read', 'src/greet.js', 'return `Hello, ${name}!`']],
    final: '1 条判决：TC-GREET-002 → product_bug（置信度 0.90），路由 fix-code。',
  },
  'fix-code': {
    plan: '按判决提示补空名字分支；只改 src/，不碰 tests/。',
    tools: [['Read', 'reports/verdict-iter1.json'], ['Edit', 'tests/run-cases.mjs', '+1 −1（被守卫还原）', false], ['Edit', 'src/greet.js', '+2 −1', true], ['Bash', 'npm test', 'cases 2 · passed 2', true]],
    final: '已修复 src/greet.js：空名字返回 DEFAULT_NAME。',
  },
  impact: {
    plan: '从 CodeGraph 取 greet() 的下游调用链，逐个判断行为变化。',
    tools: [['Grep', 'greet\\(', '3 处调用'], ['Write', 'reports/impact.md', '写入 22 行']],
    final: '影响面：3 处调用方，建议补 1 条接口用例。',
  },
  'knowledge-writeback': {
    plan: '只沉淀经过验证的规则和踩坑，写成 diff 供人审。',
    tools: [['Read', 'reports/quality.md'], ['Read', 'docs/wiki/greeting.md'], ['Write', 'reports/knowledge-diff.md']],
    final: '知识回流建议已写入 reports/knowledge-diff.md。',
  },
}

function narrationFor(id: string) {
  const base = id.split('/').pop()!
  return NARRATION[id] ?? NARRATION[base] ?? { plan: '读取声明的输入，按节点目标产出结果。', tools: [['Read', 'spec/spec.md']], final: '完成。' }
}

function buildPrompt(t: TplNode, reqId: string, inputs: ArtifactRef[], missing: string[]): string {
  const lines = [
    `# 角色：${t.role}`,
    `（角色说明见 .takt/agents/${t.role}.md，已追加到系统提示）`,
    '',
    '## 任务',
    t.prompt ?? '',
    '',
    `## 公共存放区：.takt/workspaces/${reqId}/`,
    '',
    '读取（引擎已解析的版本）：',
    ...inputs.map((r) => `- ${r.path}@v${r.version}`),
    ...missing.map((m) => `- ${m}（可选，不存在）`),
  ]
  if (t.outputs?.length) lines.push('', '产出（结束后由引擎收集并记版本）：', ...t.outputs.map((o) => `- ${o.path}  [${o.kind}]`))
  lines.push('', '## 约束', '- 只在 writeScope 内写文件，越界的改动会被还原并记 guard.violation', '- 结论写进存放区，不依赖会话记忆；需要人确认的写进 decisions/', '- 完成后输出一段 JSON：{ "summary": string, "outputs": string[] }')
  return lines.join('\n')
}

function resolveInputs(t: TplNode, records: ArtifactRecord[], beforeMs: number): { refs: ArtifactRef[]; missing: string[] } {
  const refs: ArtifactRef[] = []
  const missing: string[] = []
  for (const raw of t.inputs ?? []) {
    const optional = raw.endsWith('?')
    const glob = raw.replace(/\?$/, '')
    const re = globToRegex(glob)
    const hits = records.filter((r) => re.test(r.path))
    let found = false
    for (const r of hits) {
      const v = [...r.versions].reverse().find((x) => Date.parse(x.createdAt) <= beforeMs)
      if (v) {
        refs.push({ workspace: '', path: r.path, version: v.version })
        found = true
      }
    }
    if (!found && optional) missing.push(glob)
  }
  return { refs, missing }
}

function buildRun(plan: RunPlan, records: ArtifactRecord[], contents: Map<string, StoredContent>): MockRun {
  const at = (min: number) => plan.start + min * MIN
  const tpl = new Map<string, TplNode>()
  for (const t of SDLC) {
    tpl.set(t.id, t)
    if (t.id === P) for (const item of plan.items) for (const c of expandItem(item)) tpl.set(c.id, c)
  }
  // 展开节点插在 planner 后面
  const order: TplNode[] = []
  for (const t of SDLC) {
    order.push(t)
    if (t.id === P) for (const item of plan.items) order.push(...expandItem(item))
  }

  const nodes: GraphNode[] = []
  const states: Record<string, NodeState> = {}
  const live: string[] = []
  for (const t of order) {
    const p = plan.nodes[t.id] ?? { status: 'pending' as NodeStatus, execs: [] }
    const u = p.execs.reduce<Usage | undefined>((acc, e) => (e.usage ? addUsage(acc ?? ZERO, usage(...e.usage)) : acc), undefined)
    const last = p.execs[p.execs.length - 1]
    const harness = t.role ? HARNESS[t.role] : undefined
    const g: GraphNode = {
      id: t.id,
      kind: t.kind,
      title: t.title,
      stage: t.stage,
      status: p.status,
      parent: t.parent,
      role: t.kind === 'agent' || t.kind === 'judge' || t.kind === 'planner' ? t.role : undefined,
      harness,
      attempts: p.execs.length ? 1 : 0,
      iteration: last?.iteration ?? (t.kind === 'loop' ? Math.max(0, ...Object.values(plan.nodes).flatMap((n) => n.execs.map((e) => e.iteration ?? 0))) || undefined : undefined),
      usage: u,
    }
    if (t.id === `${L}/fix-code` && p.execs.length > 1) g.attempts = p.execs.length
    nodes.push(g)
    if (p.status === 'running') live.push(t.id)
    const first = p.execs[0]
    const { refs } = first ? resolveInputs(t, records, at(first.start)) : { refs: [] }
    states[t.id] = {
      id: t.id,
      status: p.status,
      attempts: g.attempts,
      iteration: g.iteration,
      startedAt: first ? iso(at(first.start)) : undefined,
      endedAt: last?.end !== undefined && p.status !== 'running' && p.status !== 'waiting_human' ? iso(at(last.end)) : undefined,
      inputs: refs.map((r) => ({ ...r, workspace: plan.reqId })),
      outputs: records.flatMap((r) => r.versions.filter((v) => v.producedBy?.runId === plan.runId && v.producedBy.nodeId === t.id).map((v) => ({ workspace: plan.reqId, path: r.path, version: v.version }))),
      error: p.error,
      usage: u,
      sessionRef: harness && first ? { harness, sessionId: `${harness === 'codex' ? 'cx' : 'cc'}-${fakeHash(plan.runId + t.id).slice(0, 12)}` } : undefined,
    }
  }

  // 边：依赖、判决路由、动态展开
  const edges: GraphEdge[] = []
  const routeTargets = new Set<string>()
  for (const t of order) {
    if (t.kind === 'judge' && t.routes) {
      for (const [cat, target] of Object.entries(t.routes)) {
        const to = `${L}/${target}`
        routeTargets.add(`${t.id}→${to}`)
        edges.push({ from: t.id, to, kind: 'route', label: cat })
      }
    }
  }
  for (const t of order) {
    for (const n of t.needs) if (!routeTargets.has(`${n}→${t.id}`)) edges.push({ from: n, to: t.id, kind: 'dep' })
    if (t.parent === P && t.id.endsWith('/code')) edges.push({ from: P, to: t.id, kind: 'expand' })
  }

  // 上下文账本与 prompt
  const context = new Map<string, { snapshots: ContextSnapshot[]; compactions: CompactionRecord[] }>()
  const prompts = new Map<string, string>()
  for (const t of order) {
    const p = plan.nodes[t.id]
    const first = p?.execs[0]
    if (!first || !t.role || t.kind === 'human' || t.kind === 'gate' || t.kind === 'script') continue
    const { refs, missing } = resolveInputs(t, records, at(first.start))
    const prompt = buildPrompt(t, plan.reqId, refs, missing)
    prompts.set(t.id, prompt)
    const harness = HARNESS[t.role] ?? 'claude-code'
    const items: ContextItem[] = [
      { id: 'sys', source: 'system', title: harness === 'codex' ? 'Codex 系统提示' : 'Claude Code 系统提示', tokens: harness === 'codex' ? 2480 : 3120, included: true },
      { id: 'role', source: 'role', title: `角色说明 · ${t.role}`, ref: `.takt/agents/${t.role}.md`, tokens: ROLE_TOKENS[t.role] ?? 800, included: true },
    ]
    const skill = SKILLS[t.role]
    if (skill) items.push({ id: 'skill', source: 'skill', title: skill[0].replace('skills/', '').replace('.md', ''), ref: skill[0], tokens: skill[1], included: true })
    for (const r of refs) {
      const c = contents.get(`${plan.reqId}:${r.path}@${r.version}`)
      const image = c?.encoding === 'base64'
      items.push({
        id: `a:${r.path}`,
        source: 'artifact',
        title: r.path.split('/').pop()!,
        ref: `${r.path}@v${r.version}`,
        tokens: image ? 1650 : estTokens(c?.content ?? ''),
        included: !image,
        reason: image ? '图片：当前 harness 不接收图像输入，只注入链接' : undefined,
      })
    }
    for (const m of missing) items.push({ id: `m:${m}`, source: 'artifact', title: m, ref: m, tokens: 0, included: false, reason: '可选输入：存放区中不存在' })
    if (t.id === 'design' || t.id === 'impact') {
      items.push({ id: 'k1', source: 'knowledge', title: 'CodeGraph · greet() 调用方', ref: 'codegraph:src/greet.js#greet', tokens: 560, included: true })
      items.push({ id: 'k2', source: 'knowledge', title: 'Wiki · 问候语规范', ref: 'docs/wiki/greeting.md', tokens: 420, included: true })
    }
    if (t.id.endsWith('/code')) items.push({ id: 'k3', source: 'knowledge', title: 'Wiki · 问候语规范 §空名字', ref: 'docs/wiki/greeting.md#空名字', tokens: 280, included: true })
    items.push({ id: 'prompt', source: 'prompt', title: '节点 prompt（渲染后）', tokens: estTokens(prompt) + 40, included: true })
    const totalTokens = items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0)
    const base: ContextSnapshot = { nodeId: t.id, at: iso(at(first.start) + 3000), budgetTokens: BUDGET, totalTokens, items }
    const custom = plan.snapshots?.[t.id]
    context.set(t.id, custom ? custom(at, base) : { snapshots: [base], compactions: [] })
  }

  const events = buildEvents(plan, order, context, records, at)
  const finished = plan.status !== 'running' && plan.status !== 'waiting_human'
  return {
    state: {
      runId: plan.runId,
      workflowId: 'sdlc',
      workflowVersion: '0.1.0',
      requirementId: plan.reqId,
      status: plan.status,
      startedAt: iso(plan.start),
      endedAt: finished && plan.end !== undefined ? iso(at(plan.end)) : undefined,
      args: { caseCommand: 'npm test', maxLoop: 5 },
      nodes: states,
      expansions: plan.items.length
        ? [{ plannerId: P, items: plan.items, nodeIds: plan.items.flatMap((i) => [`${P}/${i.key}/code`, `${P}/${i.key}/review`]), at: iso(at(plan.nodes[P]?.execs[0]?.end ?? 0)) }]
        : [],
    },
    workflow: { id: 'sdlc', title: '标准交付流水线', version: '0.1.0', stages: STAGES },
    graph: { nodes, edges },
    events,
    tpl,
    context,
    prompts,
    gates: plan.gates,
    live,
  }
}

function buildEvents(
  plan: RunPlan,
  order: TplNode[],
  context: Map<string, { snapshots: ContextSnapshot[]; compactions: CompactionRecord[] }>,
  records: ArtifactRecord[],
  at: (min: number) => number,
): EventEnvelope[] {
  const raw: RawEvent[] = []
  const push = <T extends EventType>(ts: number, type: T, actor: Actor, data: EventPayloads[T], nodeId?: string) => {
    if (ts <= Date.now()) raw.push({ ts, type, actor, data, nodeId })
  }
  push(plan.start, 'run.started', ENGINE, { workflowId: 'sdlc', workflowVersion: '0.1.0', args: { caseCommand: 'npm test', maxLoop: 5 } })

  for (const t of order) {
    const p = plan.nodes[t.id]
    if (!p) continue
    const actor = t.role && t.kind !== 'human' ? agentActor(t.role) : ENGINE
    p.execs.forEach((e, idx) => {
      const s = at(e.start)
      const end = e.end !== undefined ? at(e.end) : undefined
      const span = (end ?? Date.now()) - s
      const tick = (f: number) => s + span * f
      push(s, 'node.started', ENGINE, { attempt: 1, iteration: e.iteration }, t.id)

      if (t.kind === 'loop') {
        const iters = new Set(order.filter((c) => c.parent === t.id).flatMap((c) => plan.nodes[c.id]?.execs.map((x) => x.iteration ?? 1) ?? []))
        for (const i of iters) {
          const rc = plan.nodes[`${L}/run-cases`]?.execs.find((x) => x.iteration === i)
          if (rc) push(at(rc.start) - 1000, 'log', ENGINE, { level: 'info', message: `第 ${i} 轮开始` }, t.id)
        }
      }

      if (t.kind === 'agent' || t.kind === 'planner' || (t.kind === 'judge' && e.usage)) {
        const harness = HARNESS[t.role ?? ''] ?? 'claude-code'
        push(tick(0.02), 'harness.started', actor, { harness, model: MODEL[harness], sessionId: `${harness === 'codex' ? 'cx' : 'cc'}-${fakeHash(plan.runId + t.id).slice(0, 12)}` }, t.id)
        const ctx = context.get(t.id)
        if (ctx && idx === 0) push(tick(0.03), 'context.assembled', ENGINE, ctx.snapshots[0]!, t.id)
        const n = narrationFor(t.id)
        const key = t.id.split('/')[1] ?? ''
        push(tick(0.08), 'harness.message', actor, { role: 'assistant', text: n.plan }, t.id)
        n.tools.forEach(([tool, input, output, okFlag], i) => {
          push(tick(0.15 + (0.7 * i) / Math.max(1, n.tools.length)), 'harness.tool_call', actor, { tool, input: input.replace('<key>', key), output: output?.replace('<key>', key), ok: okFlag ?? true }, t.id)
        })
        if (t.id === 'design' || t.id === 'impact') push(tick(0.1), 'knowledge.query', ENGINE, { query: { text: '与本需求相关的现有模块、接口和数据表', intent: 'impact' }, sources: ['codegraph', 'wiki'], hits: 4 }, t.id)
        if (end) {
          push(end - 4000, 'harness.message', actor, { role: 'assistant', text: n.final }, t.id)
          if (e.usage) push(end - 2000, 'harness.usage', actor, usage(...e.usage), t.id)
        }
      }
      if (t.kind === 'judge' && !e.usage && end) push(tick(0.5), 'log', ENGINE, { level: 'info', message: '上游没有失败用例，判决直接成功（不调用模型）' }, t.id)

      if (t.kind === 'script' && end) {
        const msg = t.id.endsWith('run-cases') ? `执行 npm test（第 ${e.iteration ?? 1} 轮）` : t.id === 'freeze' ? '写入冻结基线' : '汇总用例结论与 AC 覆盖'
        push(tick(0.3), 'log', ENGINE, { level: 'info', message: msg }, t.id)
      }

      if (t.kind === 'human') {
        const requestId = `att-${plan.runId.slice(-4)}-${t.id}`
        push(s, 'human.requested', ENGINE, { requestId, ask: t.ask ?? '', form: t.form ?? 'approve' }, t.id)
        const a = plan.answers?.[t.id]
        if (end && a) push(end, 'human.answered', human(a.by), { requestId, decision: a.decision, answer: a.answer }, t.id)
      }

      if (t.kind === 'gate' && end) {
        const g = plan.gates?.[t.id]
        if (g) push(end - 500, 'gate.result', ENGINE, g, t.id)
      }

      if (t.kind === 'judge' && end) {
        const v = plan.verdicts?.[t.id]?.find((x) => x.iteration === (e.iteration ?? 1))
        if (v) push(end - 1000, 'judge.verdict', actor, { verdicts: v.verdicts, routed: v.routed }, t.id)
      }

      if (t.kind === 'planner' && end) {
        push(end - 300, 'dag.expanded', ENGINE, { plannerId: P, items: plan.items, nodeIds: plan.items.flatMap((i) => [`${P}/${i.key}/code`, `${P}/${i.key}/review`]), at: iso(end) }, t.id)
      }

      if (end) {
        // 产物写入：只记本节点在这一轮产出的版本
        for (const r of records) {
          for (const v of r.versions) {
            if (v.producedBy?.runId !== plan.runId || v.producedBy.nodeId !== t.id) continue
            const vt = Date.parse(v.createdAt)
            if (vt >= s - 1000 && vt <= end + 1000) push(end - 800, 'artifact.written', actor, { ref: { workspace: plan.reqId, path: r.path, version: v.version }, kind: r.kind, sha256: v.sha256 }, t.id)
          }
        }
        const status = e.status ?? p.status
        if (status === 'failed') push(end, 'node.failed', ENGINE, { error: p.error ?? '失败', attempt: 1 }, t.id)
        else if (status !== 'waiting_human' && status !== 'running')
          push(end, 'node.finished', ENGINE, { status: status === 'stale' ? 'succeeded' : status, outputs: [], usage: e.usage ? usage(...e.usage) : undefined }, t.id)
      }
    })
  }

  for (const ctx of context.values()) {
    ctx.snapshots.slice(1).forEach((s) => push(Date.parse(s.at), 'context.assembled', ENGINE, s, s.nodeId))
    ctx.compactions.forEach((c) => push(Date.parse(c.at), 'context.compacted', ENGINE, c, c.nodeId))
  }
  for (const e of plan.extra?.(at) ?? []) if (e.ts <= Date.now()) raw.push(e)
  if (plan.end !== undefined && plan.status !== 'running' && plan.status !== 'waiting_human') push(at(plan.end), 'run.finished', ENGINE, { status: plan.status })

  raw.sort((a, b) => a.ts - b.ts)
  let prevHash = '0'.repeat(64)
  return raw.map((r, i) => {
    const body = { seq: i + 1, ts: iso(r.ts), runId: plan.runId, nodeId: r.nodeId, type: r.type, actor: r.actor, data: r.data }
    const hash = fakeHash(prevHash + JSON.stringify(body))
    const env = { ...body, prevHash, hash } as EventEnvelope
    prevHash = hash
    return env
  })
}

// ============================================================ 需求与计划

export interface MockDb {
  project: { name: string; description: string }
  requirements: Requirement[]
  artifacts: Map<string, ArtifactRecord[]>
  contents: Map<string, StoredContent>
  comments: ArtifactComment[]
  runs: Map<string, MockRun>
  attention: AttentionItem[]
  traces: Map<string, TraceGraph>
  metrics: Map<string, RequirementMetrics>
}

export function createMockDb(): MockDb {
  const contents = new Map<string, StoredContent>()
  const artifacts = new Map<string, ArtifactRecord[]>()
  const runs = new Map<string, MockRun>()

  // ---------------------------------------------------------------- REQ-001：完整跑完
  const r1 = NOW - 168 * MIN
  const m1 = (x: number) => r1 + x * MIN
  const RUN1 = 'run-20261104-0001'
  const pm = agentActor('pm')
  const arch = agentActor('architect')
  const td = agentActor('test-designer')
  const dev = agentActor('dev')
  const rev = agentActor('reviewer')
  const judgeA = agentActor('judge')
  const v = (content: string, x: number, author: Actor, node?: string, reason?: string, derivedFrom?: string[]): VersionSpec => ({ content, at: m1(x), author, node, runId: node ? RUN1 : undefined, reason, derivedFrom })

  const req1Specs: ArtSpec[] = [
    { path: 'inputs/prd.md', kind: 'input', title: 'PRD · 问候语支持空名字', tags: ['prd'], versions: [{ content: C.PRD, at: r1 - 22 * MIN, author: human('wayne'), reason: 'takt ws put 导入 PRD' }] },
    { path: 'inputs/meeting-1103.md', kind: 'input', title: '需求评审会纪要 11-03', tags: ['纪要'], versions: [{ content: C.MEETING, at: r1 - 20 * MIN, author: human('lin'), reason: '同步评审结论' }] },
    { path: 'inputs/greet-flow.svg', kind: 'input', title: '交互稿 · 空名字态', tags: ['设计稿'], versions: [{ content: C.SKETCH_SVG, at: r1 - 19 * MIN, author: human('wayne'), reason: '从设计稿导出' }] },
    { path: 'spec/clarify.md', kind: 'clarification', title: '需求澄清', versions: [v(C.CLARIFY_V1, 3.5, pm, 'clarify', '列出待确认问题', ['inputs/prd.md@1', 'inputs/meeting-1103.md@1']), v(C.CLARIFY_V2, 20.5, human('wayne'), undefined, '逐条回答澄清问题')] },
    { path: 'spec/spec.md', kind: 'spec', title: 'Spec', tags: ['冻结'], versions: [v(C.SPEC_V1, 23.5, pm, 'spec', '根据物料与澄清结论编写 spec', ['inputs/prd.md@1', 'spec/clarify.md@2']), v(C.SPEC_V2, 36, human('wayne'), undefined, 'AC-2 补充全角空格视同空名字（评审意见）', ['spec/spec.md@1'])] },
    { path: 'design/design.md', kind: 'design', title: '系分', versions: [v(C.DESIGN, 43.5, arch, 'design', '系分：改动范围与方案', ['spec/spec.md@2'])] },
    { path: 'design/contracts.json', kind: 'contract', title: '行为契约', versions: [v(C.CONTRACTS, 43.6, arch, 'design', '契约：greet() 行为规则', ['spec/spec.md@2'])] },
    { path: 'test-plan/plan.md', kind: 'test-plan', title: '测试计划', versions: [v(C.TEST_PLAN, 62, td, 'test-design', '测分', ['spec/spec.md@2', 'design/contracts.json@1'])] },
    { path: 'cases/TC-GREET-001.json', kind: 'case', title: '正常名字返回问候语', versions: [v(C.CASE_1, 62.4, td, 'test-design', '用例设计', ['spec/spec.md@2'])] },
    { path: 'cases/TC-GREET-002.json', kind: 'case', title: '空名字返回 stranger', versions: [v(C.CASE_2, 62.5, td, 'test-design', '用例设计', ['spec/spec.md@2'])] },
    { path: 'decisions/baseline.json', kind: 'decision', title: '冻结基线', versions: [v(C.baseline(RUN1, iso(m1(71.2))), 71.25, ENGINE, 'freeze', '冻结 spec / 契约 / 用例基线', ['spec/spec.md@2', 'cases/TC-GREET-001.json@1', 'cases/TC-GREET-002.json@1'])] },
    { path: 'tasks/greet-core.md', kind: 'task', title: '任务 · 默认称呼常量', versions: [v(C.TASK_CORE, 78.8, dev, `${P}/greet-core/code`, '实现任务 greet-core', ['spec/spec.md@2', 'design/design.md@1'])] },
    { path: 'tasks/greet-empty.md', kind: 'task', title: '任务 · 空名字分支', versions: [v(C.TASK_EMPTY, 89.8, dev, `${P}/greet-empty/code`, '实现任务 greet-empty', ['spec/spec.md@2', 'design/design.md@1'])] },
    { path: 'reports/review-greet-core.md', kind: 'review', title: '评审 · greet-core', versions: [v(C.REVIEW_CORE, 80.8, rev, `${P}/greet-core/review`, '代码评审', ['tasks/greet-core.md@1'])] },
    { path: 'reports/review-greet-empty.md', kind: 'review', title: '评审 · greet-empty', versions: [v(C.REVIEW_EMPTY, 91.8, rev, `${P}/greet-empty/review`, '代码评审', ['tasks/greet-empty.md@1'])] },
    { path: 'evidence/summary.json', kind: 'evidence', title: '执行汇总', versions: [v(C.SUMMARY_V1, 92.9, ENGINE, `${L}/run-cases`, '第 1 轮执行', ['cases/TC-GREET-001.json@1', 'cases/TC-GREET-002.json@1']), v(C.SUMMARY_V2, 101.9, ENGINE, `${L}/run-cases`, '第 2 轮执行', ['cases/TC-GREET-001.json@1', 'cases/TC-GREET-002.json@1'])] },
    { path: 'evidence/TC-GREET-002/result.json', kind: 'evidence', title: 'TC-GREET-002 执行结果', versions: [v(C.RESULT_002_V1, 92.85, ENGINE, `${L}/run-cases`, '第 1 轮执行'), v(C.RESULT_002_V2, 101.85, ENGINE, `${L}/run-cases`, '第 2 轮执行')] },
    { path: 'evidence/TC-GREET-002/terminal.svg', kind: 'evidence', title: 'TC-GREET-002 终端截图（第 1 轮）', versions: [v(C.TERMINAL_SVG, 92.88, ENGINE, `${L}/run-cases`, '第 1 轮执行证据')] },
    { path: 'reports/verdict-iter1.json', kind: 'verdict', title: '第 1 轮判决', versions: [v(C.VERDICT_JSON, 94.8, judgeA, `${L}/judge`, '失败归因', ['evidence/summary.json@1', 'evidence/TC-GREET-002/result.json@1', 'spec/spec.md@2'])] },
    { path: 'reports/impact.md', kind: 'report', title: '影响面评估', versions: [v(C.IMPACT, 111.8, rev, 'impact', '影响面评估', ['tasks/greet-core.md@1', 'tasks/greet-empty.md@1', 'design/design.md@1'])] },
    { path: 'reports/quality.md', kind: 'report', title: '质量报告', tags: ['准出'], versions: [v(C.QUALITY, 112.15, ENGINE, 'quality-report', '汇总 AC 覆盖', ['spec/spec.md@2', 'evidence/summary.json@2'])] },
    { path: 'decisions/acceptance.md', kind: 'decision', title: '准出决策', versions: [v(C.ACCEPTANCE, 130.5, human('wayne'), undefined, '准出验收结论')] },
    { path: 'reports/knowledge-diff.md', kind: 'knowledge', title: '知识回流建议', versions: [v(C.KNOWLEDGE_DIFF, 133.8, pm, 'knowledge-writeback', '沉淀业务规则与踩坑', ['spec/spec.md@2', 'reports/quality.md@1'])] },
  ]
  const rec1 = buildArtifacts('REQ-001', req1Specs, contents)
  artifacts.set('REQ-001', rec1)

  const verdict1: JudgeVerdict = {
    subject: 'TC-GREET-002',
    category: 'product_bug',
    confidence: 0.9,
    rationale: C.VERDICT_RATIONALE,
    evidence: ['evidence/TC-GREET-002/result.json', 'src/greet.js:3', 'spec/spec.md#AC-2'],
    fixScope: 'mechanical',
    fixHint: "在 greet() 中对 name.trim() === '' 返回 DEFAULT_NAME",
  }

  const plan1: RunPlan = {
    runId: RUN1,
    reqId: 'REQ-001',
    start: r1,
    status: 'succeeded',
    end: 134,
    items: [
      { key: 'greet-core', title: '默认称呼常量', role: 'dev' },
      { key: 'greet-empty', title: '空名字分支', role: 'dev', dependsOn: ['greet-core'] },
    ],
    nodes: {
      clarify: ok(0.2, 3.6, [14.2, 2.1]),
      'answer-clarify': ok(3.6, 20.6),
      spec: ok(20.7, 23.6, [18.6, 3.4]),
      'review-spec': ok(23.6, 37.8),
      design: ok(37.9, 43.7, [32.8, 5.9]),
      'design-gate': ok(43.7, 44.9, [6.1, 0.4]),
      'review-design': ok(44.9, 56.8),
      'test-design': ok(56.9, 62.6, [26.4, 6.8]),
      'review-cases': ok(62.6, 71),
      'trace-gate': ok(71, 71.2),
      freeze: ok(71.2, 71.3),
      [P]: ok(71.3, 72.9, [21.3, 1.6]),
      [`${P}/greet-core/code`]: ok(73, 78.9, [48.2, 7.4]),
      [`${P}/greet-core/review`]: ok(78.9, 80.9, [19.7, 1.9]),
      [`${P}/greet-empty/code`]: ok(81, 89.9, [61.5, 9.2]),
      [`${P}/greet-empty/review`]: ok(89.9, 91.9, [17.4, 1.5]),
      automate: ok(71.3, 76.2, [22.9, 4.1]),
      [L]: { status: 'succeeded', execs: [{ start: 92, end: 107.6 }] },
      [`${L}/run-cases`]: { status: 'succeeded', execs: [{ start: 92.1, end: 93, iteration: 1, status: 'succeeded' }, { start: 101.2, end: 102, iteration: 2 }] },
      [`${L}/judge`]: { status: 'succeeded', execs: [{ start: 93.1, end: 95, iteration: 1, usage: [15.8, 1.2] }, { start: 102.1, end: 102.2, iteration: 2 }] },
      [`${L}/fix-code`]: { status: 'succeeded', execs: [{ start: 95.1, end: 101.1, iteration: 1, usage: [28.6, 3.3] }] },
      [`${L}/fix-script`]: { status: 'skipped', execs: [] },
      [`${L}/fix-case`]: { status: 'skipped', execs: [] },
      impact: ok(107.7, 111.9, [24.1, 2.6]),
      'quality-report': ok(112, 112.2),
      acceptance: ok(112.2, 130.6),
      'knowledge-writeback': ok(130.7, 133.9, [12.7, 1.9]),
    },
    answers: {
      'answer-clarify': { by: 'wayne', answer: '见 spec/clarify.md v2 的答复表：1→C（含全角空格），2→A（写死常量），3→A（原样保留）。' },
      'review-spec': { by: 'wayne', decision: 'approve', answer: '已在 v2 补充全角空格，通过。' },
      'review-design': { by: 'lin', decision: 'approve' },
      'review-cases': { by: 'qiao', decision: 'approve', answer: '全角空格放到接口用例里补。' },
      acceptance: { by: 'wayne', decision: 'approve', answer: '2/2 通过，影响面已评估，准出。' },
    },
    gates: {
      'design-gate': { pass: true, checks: [{ id: 'design-rubric', pass: true, score: 88, message: '覆盖 AC-1 / AC-2；契约规则可执行；复用现有 greet()；回滚方案明确。扣分：未写性能影响（可忽略）。' }] },
      'trace-gate': { pass: true, checks: [{ id: 'ac-covered', pass: true, message: 'AC 2 条，未覆盖 0，孤立用例 0' }] },
    },
    verdicts: {
      [`${L}/judge`]: [{ iteration: 1, verdicts: [verdict1], routed: [{ subject: 'TC-GREET-002', to: 'fix-code' }] }],
    },
    snapshots: {
      [`${P}/greet-empty/code`]: (at, base) => {
        const grown: ContextSnapshot = {
          nodeId: base.nodeId,
          at: iso(at(86.4)),
          budgetTokens: BUDGET,
          totalTokens: 0,
          items: [
            ...base.items,
            { id: 'h', source: 'history', title: '会话历史（24 轮）', tokens: 14_620, included: true },
            { id: 't1', source: 'tool_result', title: 'Read src/greet.js', ref: 'src/greet.js', tokens: 380, included: true },
            { id: 't2', source: 'tool_result', title: 'Grep "greet(" 全仓 ×3', ref: 'rg greet\\(', tokens: 6_240, included: true },
            { id: 't3', source: 'tool_result', title: 'Read tests/run-cases.mjs', ref: 'tests/run-cases.mjs', tokens: 2_110, included: true },
            { id: 't4', source: 'tool_result', title: 'Read node_modules/string-width/index.js', ref: 'node_modules/string-width/index.js', tokens: 4_870, included: true },
            { id: 't5', source: 'tool_result', title: 'Bash npm test（3 次）', ref: 'npm test', tokens: 3_960, included: true },
          ],
        }
        grown.totalTokens = grown.items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0)
        const after: ContextSnapshot = {
          nodeId: base.nodeId,
          at: iso(at(86.7)),
          budgetTokens: BUDGET,
          totalTokens: 0,
          items: [
            ...base.items,
            { id: 'h2', source: 'history', title: '压缩摘要（目标 / 约束 / 已完成改动）', tokens: 1_840, included: true },
            { id: 't1', source: 'tool_result', title: 'Read src/greet.js', ref: 'src/greet.js', tokens: 380, included: true },
            { id: 'x2', source: 'tool_result', title: 'Grep "greet(" 全仓 ×3', ref: 'rg greet\\(', tokens: 6_240, included: false, reason: '压缩时丢弃：结果已沉淀到 design/design.md' },
            { id: 'x4', source: 'tool_result', title: 'Read node_modules/string-width/index.js', ref: 'node_modules/string-width/index.js', tokens: 4_870, included: false, reason: '压缩时丢弃：与任务无关的依赖源码' },
          ],
        }
        after.totalTokens = after.items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0)
        const compaction: CompactionRecord = {
          nodeId: base.nodeId,
          at: iso(at(86.6)),
          trigger: 'auto',
          beforeTokens: grown.totalTokens,
          afterTokens: after.totalTokens,
          summary: '保留：任务目标（greet-empty：空名字返回默认称呼）、spec AC-2 原文、约束（不改 tests/、使用 DEFAULT_NAME 常量）、已完成改动（src/greet.js 判空分支草稿）。压缩后续跑只认存放区文件，原始对话已归档到 transcript。',
          dropped: ['Grep "greet(" 全仓结果 ×3（6.2k）', 'Read node_modules/string-width/index.js（4.9k）', '第 4–11 轮对话中的试错片段', '3 次 npm test 的完整输出（保留最后一次结论）'],
        }
        return { snapshots: [base, grown, after], compactions: [compaction] }
      },
    },
    extra: (at) => [
      { ts: at(97.4), nodeId: `${L}/fix-code`, type: 'guard.violation', actor: ENGINE, data: { rule: 'writeScope: src/**', paths: ['tests/run-cases.mjs'], action: 'reverted' } },
      { ts: at(97.41), nodeId: `${L}/fix-code`, type: 'log', actor: ENGINE, data: { level: 'warn', message: '开发 Agent 试图修改测试执行器，已还原；继续本节点。' } },
      { ts: at(93.05), nodeId: `${L}/run-cases`, type: 'log', actor: ENGINE, data: { level: 'warn', message: '用例命令退出码 1：1 条用例失败（TC-GREET-002）' } },
      { ts: at(101.15), nodeId: L, type: 'log', actor: ENGINE, data: { level: 'info', message: '第 1 轮未收敛：1 条失败已路由 fix-code' } },
      { ts: at(107.55), nodeId: L, type: 'log', actor: ENGINE, data: { level: 'info', message: '第 2 轮收敛：全部用例通过，退出 Loop' } },
    ],
  }
  const run1 = buildRun(plan1, rec1, contents)
  runs.set(RUN1, run1)

  // REQ-001 的一次早先取消的运行
  const r0 = NOW - 26 * 60 * MIN
  const RUN0 = 'run-20261103-0007'
  const plan0: RunPlan = {
    runId: RUN0,
    reqId: 'REQ-001',
    start: r0,
    status: 'cancelled',
    end: 9,
    items: [],
    nodes: { clarify: ok(0.2, 4.1, [13.1, 1.9]), 'answer-clarify': { status: 'cancelled', execs: [{ start: 4.1, end: 9, status: 'cancelled' }] } },
    extra: (at) => [{ ts: at(8.9), nodeId: 'answer-clarify', type: 'log', actor: human('wayne'), data: { level: 'warn', message: '物料缺评审纪要，取消本次运行，补齐后重跑' } }],
  }
  runs.set(RUN0, buildRun(plan0, rec1, contents))

  // ---------------------------------------------------------------- REQ-002：Loop 第 2 轮进行中
  const r2 = NOW - 186 * MIN
  const RUN2 = 'run-20261104-0002'
  const m2 = (x: number) => r2 + x * MIN
  const v2 = (content: string, x: number, author: Actor, node?: string, reason?: string): VersionSpec => ({ content, at: m2(x), author, node, runId: node ? RUN2 : undefined, reason })
  const exportCases = [
    ['TC-EXP-001', 'AC-1', '导出当前筛选结果为 CSV'],
    ['TC-EXP-002', 'AC-1', '导出文件名含日期'],
    ['TC-EXP-003', 'AC-2', '金额字段保留两位小数'],
    ['TC-EXP-004', 'AC-2', '中文表头 UTF-8 BOM'],
    ['TC-EXP-005', 'AC-3', '超过 1 万行分片下载'],
    ['TC-EXP-006', 'AC-3', '导出进度提示'],
    ['TC-EXP-007', 'AC-5', '无权限用户不可见按钮'],
    ['TC-EXP-008', 'AC-1', '空结果导出只含表头'],
  ] as const
  const req2Specs: ArtSpec[] = [
    { path: 'inputs/prd.md', kind: 'input', title: 'PRD · 订单导出', versions: [{ content: C.genericDoc('PRD：订单导出支持 CSV', [['背景', ['运营需要把筛选后的订单导出到表格里二次分析']], ['目标', ['当前筛选结果一键导出 CSV', '大数据量分片下载，不阻塞页面']]]), at: r2 - 40 * MIN, author: human('lin') }] },
    { path: 'spec/spec.md', kind: 'spec', title: 'Spec', versions: [v2(C.genericDoc('Spec：订单导出支持 CSV', [['验收标准', ['AC-1 导出当前筛选结果', 'AC-2 字段格式（金额两位小数、UTF-8 BOM）', 'AC-3 超过 1 万行分片并提示进度', 'AC-4 10 万行导出 30 秒内完成', 'AC-5 仅有导出权限的角色可见']]]), 22, agentActor('pm'), 'spec', '编写 spec')] },
    { path: 'design/design.md', kind: 'design', title: '系分', versions: [v2(C.genericDoc('系分：订单导出', [['方案', ['复用 /orders/search 的筛选参数', '服务端流式写 CSV，按 5000 行分片', '前端轮询导出任务进度']]]), 41, arch, 'design', '系分')] },
    { path: 'design/contracts.json', kind: 'contract', title: '接口契约', versions: [v2(JSON.stringify({ path: '/api/orders/export', method: 'POST', body: { filters: 'OrderFilter', format: 'csv' }, response: { taskId: 'string' }, errors: { 403: 'NO_EXPORT_PERMISSION', 413: 'TOO_MANY_ROWS' } }, null, 2), 41.2, arch, 'design', '契约')] },
    ...exportCases.map(([id, ac, title]) => ({ path: `cases/${id}.json`, kind: 'case' as const, title, versions: [v2(JSON.stringify({ id, title, covers: [ac] }, null, 2), 63, td, 'test-design', '用例设计')] })),
    { path: 'evidence/summary.json', kind: 'evidence', title: '执行汇总', versions: [v2(JSON.stringify({ iteration: 1, passed: 2, failed: 6 }, null, 2), 128, ENGINE, `${L}/run-cases`, '第 1 轮执行'), v2(JSON.stringify({ iteration: 2, passed: 6, failed: 2 }, null, 2), 171, ENGINE, `${L}/run-cases`, '第 2 轮执行')] },
  ]
  const rec2 = buildArtifacts('REQ-002', req2Specs, contents)
  artifacts.set('REQ-002', rec2)
  const verdict = (subject: string, category: VerdictCategory, confidence: number, rationale: string, evidence: string[], fixScope?: 'mechanical' | 'semantic'): JudgeVerdict => ({ subject, category, confidence, rationale, evidence, fixScope })
  const plan2: RunPlan = {
    runId: RUN2,
    reqId: 'REQ-002',
    start: r2,
    status: 'running',
    items: [
      { key: 'export-api', title: '导出接口', role: 'dev' },
      { key: 'csv-writer', title: 'CSV 流式写出', role: 'dev', dependsOn: ['export-api'] },
      { key: 'export-ui', title: '导出按钮与进度', role: 'dev', dependsOn: ['export-api'] },
    ],
    nodes: {
      clarify: ok(0.2, 4, [16.4, 2.4]),
      'answer-clarify': ok(4, 18),
      spec: ok(18.1, 22.1, [21.2, 4.1]),
      'review-spec': ok(22.1, 30),
      design: ok(30, 41.3, [44.1, 8.2]),
      'design-gate': ok(41.3, 42.5, [7.2, 0.5]),
      'review-design': ok(42.5, 55),
      'test-design': ok(55, 63.4, [31.7, 8.9]),
      'review-cases': ok(63.4, 74),
      'trace-gate': ok(74, 74.2),
      freeze: ok(74.2, 74.3),
      [P]: ok(74.3, 76.8, [24.6, 2.2]),
      [`${P}/export-api/code`]: ok(77, 91, [72.4, 11.8]),
      [`${P}/export-api/review`]: ok(91, 94, [22.1, 2.3]),
      [`${P}/csv-writer/code`]: ok(94.1, 112, [81.3, 13.6]),
      [`${P}/csv-writer/review`]: ok(112, 115, [20.4, 2.1]),
      [`${P}/export-ui/code`]: ok(94.1, 109, [66.9, 10.4]),
      [`${P}/export-ui/review`]: ok(109, 112.5, [18.8, 1.9]),
      automate: ok(74.3, 88, [38.2, 9.6]),
      [L]: { status: 'running', execs: [{ start: 116 }] },
      [`${L}/run-cases`]: { status: 'succeeded', execs: [{ start: 116.2, end: 128, iteration: 1 }, { start: 160, end: 171, iteration: 2 }] },
      [`${L}/judge`]: { status: 'running', execs: [{ start: 128.1, end: 133, iteration: 1, usage: [26.3, 3.1] }, { start: 171.2, iteration: 2, usage: [9.4, 0.6] }] },
      [`${L}/fix-code`]: ok(133.1, 151, [57.2, 7.7], 1),
      [`${L}/fix-script`]: ok(133.1, 146, [31.5, 4.4], 1),
      [`${L}/fix-case`]: { status: 'skipped', execs: [] },
    },
    answers: {
      'answer-clarify': { by: 'lin', answer: '金额统一两位小数；导出上限 10 万行。' },
      'review-spec': { by: 'lin', decision: 'approve' },
      'review-design': { by: 'chen', decision: 'approve' },
      'review-cases': { by: 'qiao', decision: 'approve' },
    },
    gates: {
      'design-gate': { pass: true, checks: [{ id: 'design-rubric', pass: true, score: 84, message: '契约完整；分片方案明确；建议补充导出任务的过期清理。' }] },
      'trace-gate': { pass: true, checks: [{ id: 'ac-covered', pass: true, message: 'AC 5 条（AC-4 性能已转专项豁免），未覆盖 0，孤立用例 0' }] },
    },
    verdicts: {
      [`${L}/judge`]: [
        {
          iteration: 1,
          verdicts: [
            verdict('TC-EXP-003', 'product_bug', 0.86, '金额字段直接输出浮点数（12.5 而非 12.50），与 AC-2 和契约不符。', ['evidence/TC-EXP-003/result.json', 'src/export/csv.ts:42'], 'mechanical'),
            verdict('TC-EXP-005', 'product_bug', 0.78, '超过 1 万行时服务端一次性写出，没有分片，响应超时。', ['evidence/TC-EXP-005/log.txt', 'src/export/stream.ts:18'], 'semantic'),
            verdict('TC-EXP-006', 'script_defect', 0.82, '脚本在进度条出现前就断言，等待条件写成了固定 500ms。', ['evidence/TC-EXP-006/trace.zip'], 'mechanical'),
            verdict('TC-EXP-007', 'script_defect', 0.74, '定位器使用了已改名的 data-testid。', ['evidence/TC-EXP-007/dom.html'], 'mechanical'),
            verdict('TC-EXP-008', 'env_issue', 0.69, '测试环境订单库为空导致 500，与产品代码无关。', ['evidence/TC-EXP-008/response.json']),
            verdict('TC-EXP-002', 'flaky', 0.55, '文件名日期跨零点，重跑通过。', ['evidence/TC-EXP-002/result.json']),
          ],
          routed: [
            { subject: 'TC-EXP-003', to: 'fix-code' },
            { subject: 'TC-EXP-005', to: 'fix-code' },
            { subject: 'TC-EXP-006', to: 'fix-script' },
            { subject: 'TC-EXP-007', to: 'fix-script' },
            { subject: 'TC-EXP-008', to: 'human' },
            { subject: 'TC-EXP-002', to: 'ignore' },
          ],
        },
      ],
    },
    extra: (at) => [
      { ts: at(133.4), nodeId: `${L}/judge`, type: 'human.requested', actor: ENGINE, data: { requestId: 'att-0002-env', ask: 'TC-EXP-008 判为环境问题：测试环境订单库为空。请修复环境后回复。', form: 'answer' } },
      { ts: at(158), nodeId: `${L}/judge`, type: 'human.answered', actor: human('chen'), data: { requestId: 'att-0002-env', answer: '已导入 2000 条测试订单。' } },
    ],
  }
  const run2 = buildRun(plan2, rec2, contents)
  runs.set(RUN2, run2)

  // ---------------------------------------------------------------- REQ-003：等系分评审
  const r3 = NOW - 96 * MIN
  const RUN3 = 'run-20261104-0003'
  const m3 = (x: number) => r3 + x * MIN
  const v3 = (content: string, x: number, author: Actor, node?: string, reason?: string): VersionSpec => ({ content, at: m3(x), author, node, runId: node ? RUN3 : undefined, reason })
  const rec3 = buildArtifacts(
    'REQ-003',
    [
      { path: 'inputs/prd.md', kind: 'input', title: 'PRD · 图形验证码', versions: [{ content: C.genericDoc('PRD：登录页增加图形验证码', [['背景', ['撞库请求占登录流量的 18%']], ['目标', ['连续失败 3 次后要求图形验证码', '验证码 5 分钟过期']]]), at: r3 - 30 * MIN, author: human('qiao') }] },
      { path: 'spec/clarify.md', kind: 'clarification', title: '需求澄清', versions: [v3(C.genericDoc('需求澄清', [['待确认', ['失败次数按账号还是按 IP 统计？', '验证码是否区分大小写？']]]), 4, pm, 'clarify', '列出待确认问题')] },
      { path: 'spec/spec.md', kind: 'spec', title: 'Spec', versions: [v3(C.genericDoc('Spec：登录页增加图形验证码', [['验收标准', ['AC-1 同一账号连续失败 3 次后出现验证码', 'AC-2 验证码 5 分钟过期，过期后刷新', 'AC-3 验证码不区分大小写']]]), 24, pm, 'spec', '编写 spec')] },
      { path: 'design/design.md', kind: 'design', title: '系分', versions: [v3(C.genericDoc('系分：图形验证码', [['方案', ['失败计数存 Redis，key = login:fail:<account>，TTL 15 分钟', '复用风控服务的验证码生成接口', '前端在 401 + need_captcha 时展示']], ['风险', ['Redis 不可用时降级为不校验（需评审确认）']]]), 52, arch, 'design', '系分')] },
      { path: 'design/contracts.json', kind: 'contract', title: '接口契约', versions: [v3(JSON.stringify({ path: '/api/login', method: 'POST', body: { account: 'string', password: 'string', captcha: 'string?' }, errors: { 401: ['BAD_CREDENTIAL', 'NEED_CAPTCHA', 'CAPTCHA_EXPIRED'] } }, null, 2), 52.2, arch, 'design', '契约')] },
    ],
    contents,
  )
  artifacts.set('REQ-003', rec3)
  runs.set(
    RUN3,
    buildRun(
      {
        runId: RUN3,
        reqId: 'REQ-003',
        start: r3,
        status: 'waiting_human',
        items: [],
        nodes: {
          clarify: ok(0.2, 4.1, [12.8, 1.7]),
          'answer-clarify': ok(4.1, 19),
          spec: ok(19.1, 24.2, [17.9, 3.2]),
          'review-spec': ok(24.2, 36),
          design: ok(36, 52.4, [39.6, 7.1]),
          'design-gate': ok(52.4, 53.6, [6.8, 0.5]),
          'review-design': { status: 'waiting_human', execs: [{ start: 53.6 }] },
        },
        answers: { 'answer-clarify': { by: 'qiao', answer: '按账号统计；不区分大小写。' }, 'review-spec': { by: 'qiao', decision: 'approve' } },
        gates: { 'design-gate': { pass: true, checks: [{ id: 'design-rubric', pass: true, score: 86, message: '复用风控验证码接口；降级策略需人确认。' }] } },
      },
      rec3,
      contents,
    ),
  )

  // ---------------------------------------------------------------- REQ-004：系分门禁未通过，交人裁决
  const r4 = NOW - 5 * 60 * MIN
  const RUN4 = 'run-20261104-0004'
  const m4 = (x: number) => r4 + x * MIN
  const rec4 = buildArtifacts(
    'REQ-004',
    [
      { path: 'inputs/prd.md', kind: 'input', title: 'PRD · 优惠券提醒', versions: [{ content: C.genericDoc('PRD：优惠券过期前 24 小时提醒', [['目标', ['过期前 24 小时推送站内信 + Push', '用户可在设置中关闭']]]), at: r4 - 60 * MIN, author: human('chen') }] },
      { path: 'spec/spec.md', kind: 'spec', title: 'Spec', versions: [{ content: C.genericDoc('Spec：优惠券过期提醒', [['验收标准', ['AC-1 过期前 24 小时±10 分钟内发出提醒', 'AC-2 同一张券只提醒一次', 'AC-3 关闭提醒的用户不发送', 'AC-4 跨时区用户按本地时间计算']]]), at: m4(26), author: agentActor('pm'), node: 'spec', runId: RUN4, reason: '编写 spec' }] },
      { path: 'design/design.md', kind: 'design', title: '系分', versions: [{ content: C.genericDoc('系分：优惠券过期提醒', [['方案', ['每 10 分钟扫描即将过期的券', '发送记录写 coupon_remind 表做幂等']], ['待补充', ['时区处理', '错误码定义']]]), at: m4(48), author: arch, node: 'design', runId: RUN4, reason: '系分' }] },
    ],
    contents,
  )
  artifacts.set('REQ-004', rec4)
  runs.set(
    RUN4,
    buildRun(
      {
        runId: RUN4,
        reqId: 'REQ-004',
        start: r4,
        status: 'waiting_human',
        items: [],
        nodes: {
          clarify: ok(0.2, 5, [15.1, 2.2]),
          'answer-clarify': ok(5, 21),
          spec: ok(21, 26.2, [19.4, 3.6]),
          'review-spec': ok(26.2, 33),
          design: ok(33, 48.2, [41.8, 7.6]),
          'design-gate': { status: 'failed', execs: [{ start: 48.2, end: 49.5, usage: [7.4, 0.6] }], error: 'rubric 62 < 阈值 80：契约缺错误码定义，AC-4 时区未覆盖' },
        },
        answers: { 'answer-clarify': { by: 'chen', answer: '只做站内信，Push 下期。' }, 'review-spec': { by: 'chen', decision: 'approve' } },
        gates: {
          'design-gate': { pass: false, checks: [{ id: 'design-rubric', pass: false, score: 62, message: '未覆盖 AC-4（跨时区）；契约缺少错误码；扫描任务没有失败重试与回滚方案。' }] },
        },
      },
      rec4,
      contents,
    ),
  )

  // ---------------------------------------------------------------- REQ-005：等回答澄清问题
  const r5 = NOW - 34 * MIN
  const RUN5 = 'run-20261104-0005'
  const rec5 = buildArtifacts(
    'REQ-005',
    [
      { path: 'inputs/prd.md', kind: 'input', title: 'PRD · 搜索高亮', versions: [{ content: C.genericDoc('PRD：搜索结果关键词高亮', [['目标', ['标题和摘要中命中的关键词高亮']]]), at: r5 - 10 * MIN, author: human('wayne') }] },
      { path: 'spec/clarify.md', kind: 'clarification', title: '需求澄清', versions: [{ content: C.genericDoc('需求澄清', [['待确认', ['高亮是否区分大小写？', '多个关键词是否分别着色？', '拼音 / 同义词命中是否高亮？']]]), at: r5 + 4 * MIN, author: pm, node: 'clarify', runId: RUN5, reason: '列出待确认问题' }] },
    ],
    contents,
  )
  artifacts.set('REQ-005', rec5)
  runs.set(
    RUN5,
    buildRun(
      { runId: RUN5, reqId: 'REQ-005', start: r5, status: 'waiting_human', items: [], nodes: { clarify: ok(0.2, 4.2, [11.6, 1.8]), 'answer-clarify': { status: 'waiting_human', execs: [{ start: 4.2 }] } } },
      rec5,
      contents,
    ),
  )
  artifacts.set('REQ-006', [])

  // ---------------------------------------------------------------- 需求
  const requirements: Requirement[] = [
    {
      id: 'REQ-001', title: '问候语支持空名字', status: 'delivered', owner: 'wayne', members: ['wayne', 'lin', 'qiao'],
      links: [{ type: 'meego', url: 'https://meego.example.com/story/10421', title: 'Meego #10421' }, { type: 'feishu', url: 'https://docs.example.com/greet-prd', title: 'PRD 原文' }],
      createdAt: iso(r1 - 30 * MIN), updatedAt: iso(m1(134)),
    },
    {
      id: 'REQ-002', title: '订单导出支持 CSV', status: 'active', owner: 'lin', members: ['lin', 'chen', 'qiao'],
      links: [{ type: 'meego', url: 'https://meego.example.com/story/10433', title: 'Meego #10433' }], createdAt: iso(r2 - 60 * MIN), updatedAt: iso(NOW - 4 * MIN),
    },
    { id: 'REQ-003', title: '登录页增加图形验证码', status: 'active', owner: 'qiao', members: ['qiao', 'lin'], links: [{ type: 'github', url: 'https://github.com/example/shop/issues/88', title: 'issue #88' }], createdAt: iso(r3 - 40 * MIN), updatedAt: iso(m3(53.6)) },
    { id: 'REQ-004', title: '优惠券过期前 24 小时提醒', status: 'blocked', owner: 'chen', members: ['chen', 'wayne'], links: [], createdAt: iso(r4 - 90 * MIN), updatedAt: iso(m4(49.5)) },
    { id: 'REQ-005', title: '搜索结果关键词高亮', status: 'active', owner: 'wayne', members: ['wayne'], links: [], createdAt: iso(r5 - 15 * MIN), updatedAt: iso(r5 + 4.2 * MIN) },
    { id: 'REQ-006', title: '用户头像裁剪与压缩', status: 'draft', owner: 'lin', members: ['lin'], links: [], createdAt: iso(NOW - 12 * MIN), updatedAt: iso(NOW - 12 * MIN) },
  ]

  // ---------------------------------------------------------------- 待办
  const attention: AttentionItem[] = []
  for (const run of runs.values()) {
    for (const e of run.events) {
      if (e.type !== 'human.requested') continue
      const d = e.data as EventPayloads['human.requested']
      const answered = run.events.find((x) => x.type === 'human.answered' && (x.data as EventPayloads['human.answered']).requestId === d.requestId)
      const ad = answered?.data as EventPayloads['human.answered'] | undefined
      if (run.state.status === 'cancelled' && !ad) continue
      attention.push({ requestId: d.requestId, runId: run.state.runId, nodeId: e.nodeId!, requirementId: run.state.requirementId, ask: d.ask, form: d.form, choices: d.choices, createdAt: e.ts, answeredAt: answered?.ts, decision: ad?.decision, answer: ad?.answer })
    }
  }
  attention.push({
    requestId: 'att-0004-design-gate', runId: RUN4, nodeId: 'design-gate', requirementId: 'REQ-004',
    ask: '系分门禁未通过（rubric 62 < 80）：未覆盖 AC-4 跨时区、契约缺少错误码、扫描任务无重试方案。请裁决。',
    form: 'choice', choices: ['打回重做系分', '放行', '转人工补充后重跑'], createdAt: iso(m4(49.5)),
  })
  const pendingQuestions = attention.find((a) => a.requirementId === 'REQ-005' && !a.answeredAt)
  if (pendingQuestions) pendingQuestions.ask = '3 个待确认问题：① 高亮是否区分大小写？② 多个关键词是否分别着色？③ 拼音 / 同义词命中是否高亮？可在 spec/clarify.md 里逐条回答，或在这里统一答复。'

  // ---------------------------------------------------------------- 评论
  const comments: ArtifactComment[] = [
    { id: 'c1', path: 'spec/spec.md', version: 1, author: human('qiao'), body: 'AC-2 的"空白字符"是否包括全角空格？纪要里说是，但 spec 里没写。', createdAt: iso(m1(30)), resolved: true },
    { id: 'c2', path: 'spec/spec.md', version: 2, author: human('wayne'), body: '已在 v2 补充 `"\\u3000"`，下游设计与用例会被标记过期，按需重跑。', createdAt: iso(m1(36.2)) },
    { id: 'c3', path: 'reports/quality.md', version: 1, author: human('wayne'), body: '2/2 通过，准出。接口层空参数用例记到下一迭代。', createdAt: iso(m1(130)) },
    { id: 'c4', path: 'reports/verdict-iter1.json', version: 1, author: human('lin'), body: '判决正确：确实是 greet() 没处理空字符串。', createdAt: iso(m1(99)) },
  ]

  return {
    project: { name: 'hello-delivery', description: '演示项目：用 mock harness 跑通"需求 → 系分 → 测分 → 研发测试 Loop → 准出"整条交付线' },
    requirements,
    artifacts,
    contents,
    comments,
    runs,
    attention,
    traces: buildTraces(),
    metrics: buildMetrics(),
  }
}

// ============================================================ 追溯与度量

function buildTraces(): Map<string, TraceGraph> {
  const t1: TraceGraph = {
    nodes: [
      { id: 'REQ-001', type: 'requirement', label: '问候语支持空名字', status: 'delivered' },
      { id: 'spec', type: 'artifact', label: 'spec/spec.md@v2', ref: { workspace: 'REQ-001', path: 'spec/spec.md', version: 2 } },
      { id: 'contracts', type: 'artifact', label: 'design/contracts.json@v1', ref: { workspace: 'REQ-001', path: 'design/contracts.json', version: 1 } },
      { id: 'AC-1', type: 'ac', label: 'AC-1 正常名字返回问候语', status: 'covered' },
      { id: 'AC-2', type: 'ac', label: 'AC-2 空名字返回 stranger', status: 'covered' },
      { id: 'TC-GREET-001', type: 'case', label: 'TC-GREET-001', status: 'passed', ref: { workspace: 'REQ-001', path: 'cases/TC-GREET-001.json' } },
      { id: 'TC-GREET-002', type: 'case', label: 'TC-GREET-002', status: 'passed', ref: { workspace: 'REQ-001', path: 'cases/TC-GREET-002.json' } },
      { id: 'task-core', type: 'task', label: 'greet-core 默认称呼常量', status: 'done', ref: { workspace: 'REQ-001', path: 'tasks/greet-core.md' } },
      { id: 'task-empty', type: 'task', label: 'greet-empty 空名字分支', status: 'done', ref: { workspace: 'REQ-001', path: 'tasks/greet-empty.md' } },
      { id: 'code', type: 'code', label: 'src/greet.js', status: 'changed' },
      { id: 'ev-1', type: 'evidence', label: 'evidence/TC-GREET-001', status: 'passed' },
      { id: 'ev-2', type: 'evidence', label: 'evidence/TC-GREET-002', status: 'passed', ref: { workspace: 'REQ-001', path: 'evidence/TC-GREET-002/result.json' } },
      { id: 'verdict-1', type: 'verdict', label: 'product_bug · 第 1 轮', status: 'fixed', ref: { workspace: 'REQ-001', path: 'reports/verdict-iter1.json' } },
    ],
    edges: [
      { from: 'REQ-001', to: 'spec', rel: 'derives' },
      { from: 'spec', to: 'AC-1', rel: 'derives' },
      { from: 'spec', to: 'AC-2', rel: 'derives' },
      { from: 'spec', to: 'contracts', rel: 'derives' },
      { from: 'TC-GREET-001', to: 'AC-1', rel: 'covers' },
      { from: 'TC-GREET-002', to: 'AC-2', rel: 'covers' },
      { from: 'task-core', to: 'AC-1', rel: 'implements' },
      { from: 'task-empty', to: 'AC-2', rel: 'implements' },
      { from: 'code', to: 'task-core', rel: 'implements' },
      { from: 'code', to: 'task-empty', rel: 'implements' },
      { from: 'ev-1', to: 'TC-GREET-001', rel: 'verifies' },
      { from: 'ev-2', to: 'TC-GREET-002', rel: 'verifies' },
      { from: 'verdict-1', to: 'TC-GREET-002', rel: 'judged' },
    ],
  }
  const acs2 = [
    ['AC-1', '导出当前筛选结果', 'covered'],
    ['AC-2', '字段格式', 'partial'],
    ['AC-3', '分片与进度', 'covered'],
    ['AC-4', '10 万行 30 秒内', 'uncovered'],
    ['AC-5', '导出权限', 'partial'],
  ] as const
  const cases2: Array<[string, string, string]> = [
    ['TC-EXP-001', 'AC-1', 'passed'],
    ['TC-EXP-002', 'AC-1', 'passed'],
    ['TC-EXP-008', 'AC-1', 'passed'],
    ['TC-EXP-003', 'AC-2', 'failed'],
    ['TC-EXP-004', 'AC-2', 'passed'],
    ['TC-EXP-005', 'AC-3', 'passed'],
    ['TC-EXP-006', 'AC-3', 'passed'],
    ['TC-EXP-007', 'AC-5', 'failed'],
  ]
  const t2: TraceGraph = {
    nodes: [
      { id: 'REQ-002', type: 'requirement', label: '订单导出支持 CSV', status: 'active' },
      { id: 'spec', type: 'artifact', label: 'spec/spec.md@v1' },
      ...acs2.map(([id, label, status]) => ({ id, type: 'ac' as const, label: `${id} ${label}`, status })),
      ...cases2.map(([id, , status]) => ({ id, type: 'case' as const, label: id, status })),
    ],
    edges: [
      { from: 'REQ-002', to: 'spec', rel: 'derives' },
      ...acs2.map(([id]) => ({ from: 'spec', to: id, rel: 'derives' as const })),
      ...cases2.map(([id, ac]) => ({ from: id, to: ac, rel: 'covers' as const })),
    ],
  }
  const specOnly = (id: string, title: string, acs: string[]): TraceGraph => ({
    nodes: [
      { id, type: 'requirement', label: title, status: 'active' },
      { id: 'spec', type: 'artifact', label: 'spec/spec.md@v1' },
      ...acs.map((a, i) => ({ id: `AC-${i + 1}`, type: 'ac' as const, label: `AC-${i + 1} ${a}`, status: 'uncovered' })),
    ],
    edges: [{ from: id, to: 'spec', rel: 'derives' }, ...acs.map((_, i) => ({ from: 'spec', to: `AC-${i + 1}`, rel: 'derives' as const }))],
  })
  return new Map([
    ['REQ-001', t1],
    ['REQ-002', t2],
    ['REQ-003', specOnly('REQ-003', '登录页增加图形验证码', ['连续失败 3 次出现验证码', '5 分钟过期', '不区分大小写'])],
    ['REQ-004', specOnly('REQ-004', '优惠券过期前 24 小时提醒', ['24 小时±10 分钟提醒', '只提醒一次', '关闭提醒不发送', '跨时区按本地时间'])],
    ['REQ-005', { nodes: [{ id: 'REQ-005', type: 'requirement', label: '搜索结果关键词高亮', status: 'active' }], edges: [] }],
    ['REQ-006', { nodes: [], edges: [] }],
  ])
}

function buildMetrics(): Map<string, RequirementMetrics> {
  const base = (id: string, m: Partial<RequirementMetrics>): RequirementMetrics => ({ requirementId: id, runs: 1, loopIterations: 0, humanInterventions: 0, verdicts: {}, usage: ZERO, ...m })
  return new Map([
    [
      'REQ-001',
      base('REQ-001', {
        runs: 2, firstPassRate: 0.5, loopIterations: 2, humanInterventions: 5, verdicts: { product_bug: 1 }, leadTimeHours: 2.8,
        acCoverage: [
          { ac: 'AC-1', title: '正常名字返回问候语', cases: 1, passed: 1, failed: 0, status: 'covered' },
          { ac: 'AC-2', title: '空名字返回 stranger', cases: 1, passed: 1, failed: 0, status: 'covered' },
        ],
      }),
    ],
    [
      'REQ-002',
      base('REQ-002', {
        firstPassRate: 0.25, loopIterations: 2, humanInterventions: 5, verdicts: { product_bug: 2, script_defect: 2, env_issue: 1, flaky: 1 }, leadTimeHours: 4.1,
        acCoverage: [
          { ac: 'AC-1', title: '导出当前筛选结果', cases: 3, passed: 3, failed: 0, status: 'covered' },
          { ac: 'AC-2', title: '字段格式（金额、BOM）', cases: 2, passed: 1, failed: 1, status: 'partial' },
          { ac: 'AC-3', title: '分片与进度提示', cases: 2, passed: 2, failed: 0, status: 'covered' },
          { ac: 'AC-4', title: '10 万行 30 秒内完成', cases: 0, passed: 0, failed: 0, status: 'uncovered' },
          { ac: 'AC-5', title: '仅导出权限角色可见', cases: 1, passed: 0, failed: 1, status: 'partial' },
        ],
      }),
    ],
    [
      'REQ-003',
      base('REQ-003', {
        humanInterventions: 2,
        acCoverage: [
          { ac: 'AC-1', title: '连续失败 3 次出现验证码', cases: 0, passed: 0, failed: 0, status: 'uncovered' },
          { ac: 'AC-2', title: '验证码 5 分钟过期', cases: 0, passed: 0, failed: 0, status: 'uncovered' },
          { ac: 'AC-3', title: '不区分大小写', cases: 0, passed: 0, failed: 0, status: 'uncovered' },
        ],
      }),
    ],
    ['REQ-004', base('REQ-004', { humanInterventions: 2 })],
    ['REQ-005', base('REQ-005', {})],
    ['REQ-006', base('REQ-006', { runs: 0 })],
  ])
}
