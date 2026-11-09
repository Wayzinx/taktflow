import { randomUUID } from 'node:crypto'
import { DEFAULT_RECEIPT_TIMEOUT_MINUTES } from '../lead/receipts.js'
import type { StewardBlock, StewardCitation, StewardContextRef, StewardDelegation, ProposalStep, WorkflowDocument } from '../api.js'
import type { ToolSpec, RoomMessage, NodeKind, SnapshotNode, RunState, Usage, EventEnvelope } from '../types.js'
import { stageProgress } from '../insights/graph.js'
import { createInsights } from '../insights/fs-insights.js'
import { budgetStatus } from '../insights/budget.js'
import { addUsage, summarizeUsage } from '../insights/usage.js'
import { scorecards } from '../eval/scorecards.js'
import { sha256 } from '../util/hash.js'
import { validateSchema } from '../engine/schema.js'
import {
  type StewardDeps,
  type StewardSpace,
  stewardId,
  timestamp,
  StewardError,
} from './contracts.js'
import { StewardStore } from './store.js'
import { stewardLinks as links } from './links.js'
import { readStewardFile, redactSecrets } from './files.js'
import { StewardProposals } from './proposals.js'
import { refreshRisks } from './risks.js'
import { productMetrics } from './metrics.js'
import { describeBlocks, normalizeBlocks } from './blocks.js'
import { entityRun, entitySnapshot, requirementState, resolveEntityRef, stageStatus, stateTone } from './entity.js'
import { FIND_TYPES, findEntities, findInput } from './find.js'


/** 界面上的工具名：description 是写给模型的长约束，不适合直接展示在工具卡片里。 */
const TOOL_LABELS: Record<string, string> = {
  find: '查找实体',
  list_spaces: '列出空间',
  resolve_space: '核对空间',
  space_overview: '空间总览',
  resolve_requirement: '核对需求',
  list_requirements: '需求列表',
  requirement_status: '需求状态',
  run_status: '运行状态',
  list_attention: '待办',
  list_risks: '风险',
  get_metrics: '指标',
  workflow_get: '读取 workflow',
  get_config: '空间配置',
  eval_scorecards: '成绩单',
  list_commands: '可用命令',
  read_file: '读取文件',
  propose: '生成提案',
  ask_lead: '转达 Lead',
  knowledge_search: '检索知识库',
  show: '可视化',
}
const RISK_LEVEL: Record<string, string> = { high: '高', medium: '中' }
const FORM_LABEL: Record<string, string> = { approve: '审批', answer: '回答', choice: '选择' }
const compactTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const laneRank = (lane: { status: string; waiting: number }) => (lane.waiting ? 0 : lane.status === 'blocked' ? 1 : lane.status === 'active' ? 2 : lane.status === 'delivered' ? 4 : 3)
/** 时间线只留人关心的事件，节点用标题而不是 id。 */
function timelineItem(event: EventEnvelope, titles: Map<string, string>): { title: string; detail?: string; tone?: 'success' | 'failed' | 'waiting' | 'running' | 'stale' } | undefined {
  const node = event.nodeId ? titles.get(event.nodeId) ?? event.nodeId : undefined
  const payload = event.data as Record<string, unknown>
  switch (event.type) {
    case 'run.started':
      return { title: '开始运行', tone: 'running' }
    case 'run.finished':
      return payload.status === 'succeeded' ? { title: '运行完成', tone: 'success' } : { title: `运行${payload.status === 'cancelled' ? '取消' : '结束'}`, detail: String(payload.status ?? ''), tone: 'failed' }
    case 'node.finished':
      return node ? { title: `${node} 完成`, tone: payload.status === 'succeeded' || payload.status === 'done' ? 'success' : undefined } : undefined
    case 'node.failed':
      return { title: `${node ?? '节点'} 失败`, detail: String(payload.error ?? '').slice(0, 60), tone: 'failed' }
    case 'node.stale':
      return { title: `${node ?? '节点'} 已过期`, tone: 'stale' }
    case 'gate.result':
      return { title: `${node ?? '门禁'} ${payload.pass ? '通过' : '未通过'}`, tone: payload.pass ? 'success' : 'failed' }
    case 'human.requested':
      return { title: `等你：${String(payload.ask ?? node ?? '')}`.slice(0, 60), tone: 'waiting' }
    case 'human.answered':
      return { title: `${node ?? '人工节点'} 已确认`, tone: 'success' }
    default:
      return undefined
  }
}
export function delegationStatus(status: StewardDelegation['status']): import('../types.js').DelegationStatus {
  return status === 'answered' ? 'replied' : status === 'failed' ? 'uncertain' : status
}
export function resendDelegation(tools: StewardTools, messageId: string, reason: string): Promise<StewardDelegation> {
  return tools.resendDelegation(messageId, reason)
}
interface DelegationRecord { delegation: StewardDelegation; threadId: string; text: string; sentAt: string }

export interface StewardToolResult {
  data: unknown
  citations: StewardCitation[]
  summary: string
}
export interface ToolContext {
  refs?: StewardContextRef[]
  threadId: string
  messageId: string
  proposals: string[]
  delegations: StewardDelegation[]
  onDelegation?: (delegation: StewardDelegation) => Promise<void>
  onBlocks?: (blocks: StewardBlock[]) => Promise<void>
}
export class StewardTools {
  private readonly cleanups = new Set<() => void>()
  constructor(
    readonly deps: StewardDeps,
    readonly store: StewardStore,
    readonly userId: string,
    readonly proposals: StewardProposals,
  ) {}
  close(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups.clear()
  }
  async restoreDelegations(): Promise<void> {
    const delegations = await this.refreshDelegations()
    for (const delegation of delegations) {
      if (!['sent', 'taken', 'uncertain'].includes(delegationStatus(delegation.status))) continue
      const space = await this.deps.open(delegation.spaceId)
      let updates = Promise.resolve()
      const off = space.onChat(delegation.requirementId, message => {
        if (message.replyTo !== delegation.messageId) return
        updates = updates.then(async () => {
          const current = (await this.refreshDelegations()).find(item => item.messageId === delegation.messageId)
          if (current && ['replied', 'refused', 'expired'].includes(current.status)) cleanup()
        }).catch(() => cleanup())
      })
      const timer = setTimeout(() => { void this.refreshDelegations().finally(cleanup).catch(() => {}) },
        Math.max(1, DEFAULT_RECEIPT_TIMEOUT_MINUTES * 60_000 - (Date.parse(timestamp(this.deps)) - Date.parse(delegation.at))))
      timer.unref()
      const cleanup = () => { off(); clearTimeout(timer); this.cleanups.delete(cleanup) }
      this.cleanups.add(cleanup)
    }
  }
  private specCache?: { until: number; specs: ToolSpec[] }
  async specs(useCache = false): Promise<ToolSpec[]> {
    if (useCache && this.specCache && this.specCache.until > Date.now()) return this.specCache.specs
    const str = { type: 'string' },
      bool = { type: 'boolean' }
    const editableValue = {
      anyOf: [
        {
          type: 'object',
          required: ['kind', 'value'],
          properties: { kind: { type: 'string', enum: ['literal'] }, value: {} },
        },
        {
          type: 'object',
          required: ['kind', 'code'],
          properties: { kind: { type: 'string', enum: ['code'] }, code: str },
        },
      ],
    }
    const nodeKinds: NodeKind[] = [
      'script',
      'agent',
      'gate',
      'human',
      'judge',
      'loop',
      'planner',
      'review',
      'subflow',
    ]
    const workflowEdit = {
      anyOf: [
        {
          type: 'object',
          required: ['op', 'kind', 'props'],
          properties: {
            op: { type: 'string', enum: ['addNode'] },
            kind: { type: 'string', enum: nodeKinds },
            props: { type: 'object', additionalProperties: editableValue },
            after: { anyOf: [str, { type: 'null' }] },
            parent: str,
          },
        },
        { type: 'object', required: ['op', 'id'], properties: { op: { type: 'string', enum: ['removeNode'] }, id: str } },
        {
          type: 'object',
          required: ['op', 'id', 'key', 'value'],
          properties: { op: { type: 'string', enum: ['setProp'] }, id: str, key: str, value: { anyOf: [editableValue, { type: 'null' }] } },
        },
        {
          type: 'object',
          required: ['op', 'id', 'needs'],
          properties: { op: { type: 'string', enum: ['setNeeds'] }, id: str, needs: { type: 'array', items: str } },
        },
        {
          type: 'object',
          required: ['op', 'id', 'after'],
          properties: { op: { type: 'string', enum: ['moveNode'] }, id: str, after: { anyOf: [str, { type: 'null' }] }, parent: { anyOf: [str, { type: 'null' }] } },
        },
        {
          type: 'object',
          required: ['op', 'stages'],
          properties: { op: { type: 'string', enum: ['setStages'] }, stages: { type: 'array', items: { type: 'object', required: ['id', 'title'], properties: { id: str, title: str } } } },
        },
        {
          type: 'object',
          required: ['op', 'key', 'value'],
          properties: { op: { type: 'string', enum: ['setMeta'] }, key: { type: 'string', enum: ['title', 'description', 'version'] }, value: str },
        },
        {
          type: 'object',
          required: ['op', 'key', 'value'],
          properties: { op: { type: 'string', enum: ['setMetaValue'] }, key: { type: 'string', enum: ['useWhen', 'tiers', 'leadInstructions', 'dynamicRules', 'budget'] }, value: { anyOf: [editableValue, { type: 'null' }] } },
        },
      ],
    }
    const proposalStep = {
      anyOf: [
        {
          type: 'object',
          required: ['kind', 'commandId', 'input'],
          properties: { kind: { type: 'string', enum: ['command'] }, spaceId: str, commandId: str, input: { type: 'object' }, title: str },
        },
        {
          type: 'object',
          required: ['kind', 'workflowId', 'baseRev', 'edits'],
          properties: { kind: { type: 'string', enum: ['workflow'] }, spaceId: str, workflowId: str, baseRev: str, edits: { type: 'array', items: workflowEdit }, title: str },
        },
        {
          type: 'object',
          required: ['kind', 'path', 'content'],
          properties: { kind: { type: 'string', enum: ['file'] }, spaceId: str, path: str, baseHash: str, content: str, title: str },
        },
      ],
    }
    const contextRef = {
      type: 'object',
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: ['space', 'requirement', 'run', 'node', 'workflow', 'knowledge', 'file'] },
        spaceId: str,
        id: str,
        parent: str,
        label: str,
      },
    }
    const tone = { type: 'string', enum: ['neutral', 'success', 'running', 'waiting', 'failed', 'stale'] }
    const stageStatus = { type: 'string', enum: ['done', 'running', 'waiting', 'failed', 'todo', 'skipped'] }
    const action = {
      anyOf: [
        { type: 'object', required: ['kind', 'label', 'text'], properties: { kind: { type: 'string', enum: ['ask'] }, label: str, text: str, primary: bool } },
        { type: 'object', required: ['kind', 'label', 'ref'], properties: { kind: { type: 'string', enum: ['open'] }, label: str, ref: contextRef, primary: bool } },
        { type: 'object', required: ['kind', 'label', 'commandId'], properties: { kind: { type: 'string', enum: ['command'] }, label: str, commandId: str, input: { type: 'object' }, primary: bool } },
      ],
    }
    const block = {
      anyOf: [
        { type: 'object', required: ['type', 'view', 'ref'], properties: { type: { type: 'string', enum: ['entity'] }, view: { type: 'string', enum: ['card', 'stages', 'dag', 'node', 'attention'] }, ref: contextRef, focus: str } },
        { type: 'object', required: ['type', 'items'], properties: { type: { type: 'string', enum: ['pick'] }, title: str, items: { type: 'array', items: { type: 'object', required: ['ref'], properties: { ref: contextRef, why: str } } } } },
        { type: 'object', required: ['type', 'items'], properties: { type: { type: 'string', enum: ['stats'] }, title: str, items: { type: 'array', items: { type: 'object', required: ['label', 'value'], properties: { label: str, value: { anyOf: [str, { type: 'number' }] }, unit: str, tone, hint: str, ref: contextRef } } } } },
        { type: 'object', required: ['type', 'rows'], properties: { type: { type: 'string', enum: ['lanes'] }, title: str, rows: { type: 'array', items: { type: 'object', required: ['title', 'stages'], properties: { title: str, ref: contextRef, stages: { type: 'array', items: { type: 'object', required: ['label', 'status'], properties: { label: str, status: stageStatus } } }, note: str, tone } } } } },
        { type: 'object', required: ['type', 'items'], properties: { type: { type: 'string', enum: ['bars'] }, title: str, unit: str, items: { type: 'array', items: { type: 'object', required: ['label', 'value'], properties: { label: str, value: { type: 'number' }, max: { type: 'number' }, tone, hint: str, ref: contextRef } } } } },
        { type: 'object', required: ['type', 'columns', 'rows'], properties: { type: { type: 'string', enum: ['table'] }, title: str, columns: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: str, label: str, align: { type: 'string', enum: ['start', 'end'] }, mono: bool } } }, rows: { type: 'array', items: { type: 'object' } }, refs: { type: 'array', items: { anyOf: [contextRef, { type: 'null' }] } } } },
        { type: 'object', required: ['type', 'items'], properties: { type: { type: 'string', enum: ['checklist'] }, title: str, items: { type: 'array', items: { type: 'object', required: ['label', 'done'], properties: { label: str, done: bool, hint: str, ref: contextRef } } } } },
        { type: 'object', required: ['type', 'items'], properties: { type: { type: 'string', enum: ['timeline'] }, title: str, items: { type: 'array', items: { type: 'object', required: ['at', 'title'], properties: { at: str, title: str, detail: str, tone, ref: contextRef } } } } },
        { type: 'object', required: ['type', 'tone', 'title'], properties: { type: { type: 'string', enum: ['callout'] }, tone, title: str, body: str } },
        { type: 'object', required: ['type', 'items'], properties: { type: { type: 'string', enum: ['actions'] }, items: { type: 'array', items: action } } },
      ],
    }
    const preset = {
      anyOf: [
        { type: 'object', required: ['preset', 'spaceId'], properties: { preset: { type: 'string', enum: ['space_progress'] }, spaceId: str } },
        { type: 'object', required: ['preset', 'requirementId'], properties: { preset: { type: 'string', enum: ['requirement_progress'] }, spaceId: str, requirementId: str } },
        { type: 'object', required: ['preset'], properties: { preset: { type: 'string', enum: ['risks'] }, spaceId: str } },
        { type: 'object', required: ['preset'], properties: { preset: { type: 'string', enum: ['attention'] }, spaceId: str } },
      ],
    }
    const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
      ['find', '跨可见且未静音的空间查找对象，编号精确优先；ambiguous=true 时必须 show pick 问你说的是哪一个，不要猜。已有 context 需求时直接使用，无需再 find。', { q: str, types: { type: 'array', items: { type: 'string', enum: FIND_TYPES } }, spaceId: str, limit: { type: 'integer', minimum: 1 } }, ['q']],
      ['list_spaces', '列出可见空间；给 query 时返回匹配质量，不能把低质量候选当成用户点名空间', { query: str }, []],
      ['resolve_space', '解析用户点名的空间。exact=false 时必须告诉用户没找到/可能无权限，并列出 candidates，不得代入其他空间回答', { name: str }, ['name']],
      ['space_overview', '空间需求、运行与待办总览', { spaceId: str }, ['spaceId']],
      ['resolve_requirement', '解析用户点名的需求。exact=false 时必须告诉用户没找到/可能无权限，并列出 candidates，不得代入其他需求回答', { spaceId: str, name: str }, ['spaceId', 'name']],
      [
        'list_requirements',
        '列出空间需求，可按状态筛选；给 query 时返回匹配质量',
        { spaceId: str, status: str, query: str },
        ['spaceId'],
      ],
      [
        'requirement_status',
        '需求阶段、当前节点、待办、预算与档位',
        { spaceId: str, requirementId: str },
        ['spaceId', 'requirementId'],
      ],
      ['run_status', '运行状态', { spaceId: str, runId: str }, ['spaceId', 'runId']],
      ['list_attention', '查询待处理事项', { spaceId: str }, []],
      ['list_risks', '查询当前风险', { spaceId: str }, []],
      ['get_metrics', '查询需求指标或产品健康', { spaceId: str, requirementId: str }, []],
      [
        'workflow_get',
        '读取 workflow 可编辑视图。默认不返回源码；需要源码时传 includeSource=true（最多 16KB）',
        { spaceId: str, workflowId: str, includeSource: bool },
        ['spaceId', 'workflowId'],
      ],
      ['get_config', '读取已脱敏的空间配置', { spaceId: str }, ['spaceId']],
      ['eval_scorecards', '查询成绩单与退化', { spaceId: str }, ['spaceId']],
      ['list_commands', '列出命令及参数格式', { spaceId: str }, []],
      [
        'read_file',
        '读取空间内非敏感文件，最多 64KB',
        { spaceId: str, path: str },
        ['spaceId', 'path'],
      ],
      [
        'propose',
        '生成变更提案；写操作必须使用此工具。示例：{"kind":"workflow","spaceId":"standard-delivery","workflowId":"taktflow-standard","baseRev":"<workflow_get.rev>","edits":[{"op":"addNode","kind":"human","after":"review-code","props":{"id":{"kind":"literal","value":"prelaunch-confirm"},"title":{"kind":"literal","value":"上线前人工确认"},"stage":{"kind":"literal","value":"acceptance"},"needs":{"kind":"literal","value":["review-code"]},"ask":{"kind":"literal","value":"请确认是否可以进入验收。"}}},{"op":"setNeeds","id":"acceptance","needs":["prelaunch-confirm"]}]}',
        { title: str, summary: str, steps: { type: 'array', items: proposalStep, minItems: 1, maxItems: 30 } },
        ['title', 'summary', 'steps'],
      ],
      [
        'ask_lead',
        '将需求内部任务转达给 Lead，等待或异步回填',
        { spaceId: str, requirementId: str, message: str },
        ['spaceId', 'requirementId', 'message'],
      ],
      [
        'show',
        '问需求/运行/节点到哪了、卡在哪、在跑什么，空间不确定先 find，再 show entity（card/stages 配需求、dag 配运行、node 配节点且 parent 为运行编号、attention 配需求或空间）。context 已有需求直接使用。find ambiguous 时 show pick 问你说的是哪一个，不猜。snapshot 由服务端生成，不要提供。最多 3 个 entity、1 个 pick，pick 2–5 个候选。正文不超过 3 句，不用 table 或 lanes 复述同一对象；跨对象汇总仍可用 preset。',
        { blocks: { type: 'array', items: block }, preset: { type: 'array', items: preset, minItems: 1, maxItems: 3 } },
        [],
      ],
    ]
    for (const space of await this.deps.spaces())
      if ((await this.deps.open(space.id)).stores.kb) {
        definitions.push([
          'knowledge_search',
          '在已接入的知识库中检索',
          { spaceId: str, text: str, bases: { type: 'array', items: str } },
          ['spaceId', 'text'],
        ])
        break
      }
    const specs = definitions.map(([name, description, properties, required]) => ({
      name,
      description,
      parameters: { type: 'object', properties, required },
    }))
    this.specCache = { until: Date.now() + 30000, specs }
    return specs
  }
  async call(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<StewardToolResult> {
    const spec = (await this.specs(true)).find((tool) => tool.name === name)
    if (!spec) throw new StewardError(400, '工具未接入，请选择可用工具')
    try {
      validateSchema(input, spec.parameters)
    } catch (error) {
      throw new StewardError(400, `工具参数错误，请修正：${String(error)}`)
    }
    const spaceId = typeof input.spaceId === 'string' ? stewardId(input.spaceId) : undefined
    // 已归档的空间打不开，但空间管理命令（恢复 / 删除）仍要能列出：list_commands 退回服务级命令
    const space = spaceId
      ? await this.deps.open(spaceId).catch((error: unknown) => {
          if (name === 'list_commands' && (error as { status?: number }).status === 404) return undefined
          throw error
        })
      : undefined
    const citations: StewardCitation[] = []
    let data: unknown
    const cite = (label: string, href: string, kind?: StewardCitation['kind']) =>
      citations.push({ label, href, kind })
    const reqId =
      typeof input.requirementId === 'string' ? stewardId(input.requirementId) : undefined
    switch (name) {
      case 'find': {
        const history = await this.store.messages(context.threadId)
        const refs = [
          ...((await this.store.thread(context.threadId)).context ?? []),
          ...(context.refs ?? []),
          ...history.flatMap(message => [...message.context ?? [], ...(message.blocks ?? []).flatMap(block => block.type === 'entity' ? [block.ref] : [])]),
        ]
        data = await findEntities(this.deps, findInput(input), await this.store.prefs(), refs)
        break
      }
      case 'list_spaces': {
        const spaces = await this.deps.spaces()
        data = typeof input.query === 'string' && input.query.trim()
          ? this.matchSpaces(input.query, spaces)
          : spaces
        cite('空间列表', links.spaces, 'space')
        break
      }
      case 'resolve_space': {
        const result = this.resolveSpace(String(input.name), await this.deps.spaces())
        data = result
        cite('空间列表', links.spaces, 'space')
        break
      }
      case 'space_overview':
        data = {
          space: (await this.deps.spaces()).find((s) => s.id === spaceId),
          requirements: await space!.stores.workspaces.listRequirements(),
          runs: await space!.stores.runs.list(),
          attention: await space!.stores.attention.list({ pending: true }),
        }
        cite(space!.name, links.overview(spaceId!), 'space')
        break
      case 'resolve_requirement': {
        const requirements = await space!.stores.workspaces.listRequirements()
        data = this.resolveRequirement(String(input.name), requirements)
        cite('需求列表', links.overview(spaceId!), 'requirement')
        break
      }
      case 'list_requirements':
        data = (await space!.stores.workspaces.listRequirements()).filter((r) =>
          input.status ? r.status === input.status : r.status !== 'archived',
        )
        if (typeof input.query === 'string' && input.query.trim())
          data = this.matchRequirements(input.query, data as Array<{ id: string; title: string }>)
        cite('需求列表', links.overview(spaceId!), 'space')
        break
      case 'requirement_status': {
        const req = await space!.stores.workspaces.getRequirement(reqId!)
        if (!req) throw new StewardError(404, '需求不存在，请检查引用')
        const run = (await requirementState(space!, reqId!)).runs[0]
        const snapshot = run ? await space!.stores.runs.getWorkflow(run.runId) : undefined
        data = {
          requirement: req,
          stages: run && snapshot ? stageProgress(snapshot, run) : [],
          currentNodes: run
            ? Object.values(run.nodes).filter((n) =>
                ['running', 'waiting_human', 'blocked'].includes(n.status),
              )
            : [],
          attention: await space!.stores.attention.list({ requirementId: reqId, pending: true }),
          latestRun: run,
          tier: run?.route?.tier,
          budget: run
            ? budgetStatus(
                { ...run, endedAt: run.endedAt ?? timestamp(this.deps) },
                await space!.stores.events.read(run.runId),
              )
            : undefined,
        }
        cite(req.title, links.requirement(spaceId!, req.id), 'requirement')
        break
      }
      case 'run_status': {
        const run = await space!.stores.runs.get(stewardId(String(input.runId)))
        if (!run) throw new StewardError(404, '运行不存在，请检查引用')
        data = { run, events: (await space!.stores.events.read(run.runId)).slice(-20) }
        cite(run.runId, links.run(spaceId!, run.runId), 'run')
        break
      }
      case 'list_attention': {
        const spaces = space
          ? [space]
          : await Promise.all((await this.deps.spaces()).map((s) => this.deps.open(s.id)))
        data = (
          await Promise.all(
            spaces.map(async (s) => {
              cite(`${s.name} 待办`, links.attention(s.id), 'attention')
              return (await s.stores.attention.list({ pending: true })).map((item) => ({
                ...item,
                spaceId: s.id,
              }))
            }),
          )
        ).flat()
        break
      }
      case 'list_risks': {
        const risks = (await refreshRisks(this.deps, this.store)).filter(
          (risk) => risk.state === 'open' && (!spaceId || risk.spaceId === spaceId),
        )
        data = risks
        for (const risk of risks)
          for (const evidence of risk.evidence) cite(evidence.label, evidence.href, 'risk')
        if (!risks.length) cite('风险列表', links.home, 'risk')
        break
      }
      case 'get_metrics':
        data =
          space && reqId
            ? await createInsights(space.stores).metrics(reqId)
            : await productMetrics(this.deps, this.store)
        cite('指标', spaceId && reqId ? links.requirement(spaceId, reqId, 'metrics') : links.home)
        break
      case 'workflow_get':
        data = this.workflowView(
          await space!.workflows.get(stewardId(String(input.workflowId))),
          input.includeSource === true,
        )
        cite(
          String(input.workflowId),
          links.workflow(spaceId!, String(input.workflowId)),
          'workflow',
        )
        break
      case 'get_config':
        data = redactSecrets(space!.stores.config)
        cite('空间设置', links.settings(spaceId!, 'general'))
        break
      case 'eval_scorecards':
        data = await scorecards(space!.stores, { by: 'node' })
        cite('成绩单', `${links.overview(spaceId!)}/eval`)
        break
      case 'list_commands':
        data = (space ? space.commands.list() : (this.deps.serverCommands?.list() ?? [])).filter(
          (c) => !c.id.startsWith('steward.'),
        )
        cite('命令', links.home)
        break
      case 'read_file': {
        const content = await readStewardFile(space!.dir, String(input.path))
        data = { path: input.path, content, hash: sha256(content ?? '') }
        cite(String(input.path), links.settings(spaceId!, 'general'), 'file')
        break
      }
      case 'knowledge_search': {
        if (!space!.stores.kb) throw new StewardError(400, '当前空间尚未接入知识库，请先创建知识库')
        const result = await space!.stores.kb.route(
          { text: String(input.text), bases: input.bases as string[] | undefined },
          { role: 'steward', bases: input.bases as string[] | undefined },
        )
        data = result
        for (const hit of result.hits)
          cite(
            hit.title ?? hit.ref,
            links.knowledge(spaceId!, hit.baseId ?? result.bases[0]?.id ?? ''),
            'knowledge',
          )
        break
      }
      case 'show': {
        const generated: StewardBlock[] = []
        for (const item of Array.isArray(input.preset) ? input.preset : []) {
          if (item && typeof item === 'object') {
            const presetInput = item as { preset?: unknown; spaceId?: unknown; requirementId?: unknown }
            const presetSpaceId = typeof presetInput.spaceId === 'string' ? stewardId(presetInput.spaceId) : spaceId
            if (presetInput.preset === 'requirement_progress' && presetSpaceId && typeof presetInput.requirementId === 'string') {
              const presetSpace = await this.deps.open(presetSpaceId)
              const requirement = await presetSpace.stores.workspaces.getRequirement(stewardId(presetInput.requirementId))
              cite(requirement?.title ?? String(presetInput.requirementId), links.requirement(presetSpaceId, String(presetInput.requirementId)), 'requirement')
            } else if (presetInput.preset === 'attention' && presetSpaceId) {
              cite('待办', links.attention(presetSpaceId), 'attention')
            } else if (presetInput.preset === 'risks') {
              cite('风险列表', presetSpaceId ? links.overview(presetSpaceId) : links.home, 'risk')
            } else if (presetSpaceId) {
              const presetSpace = await this.deps.open(presetSpaceId)
              cite(presetSpace.name, links.overview(presetSpaceId), 'space')
            }
          }
          generated.push(...(await this.presetBlocks(item, spaceId)))
        }
        if (Array.isArray(input.blocks)) generated.push(...(input.blocks as StewardBlock[]))
        const current =
          (await this.store.messages(context.threadId)).find(
            (message) => message.id === context.messageId,
          )?.blocks ?? []
        const normalized = await normalizeBlocks([...current, ...generated], {
          refVisible: (ref) => this.refVisible(ref),
          resolveRef: (ref) => resolveEntityRef(this.deps, ref),
          snapshot: async (ref) => entitySnapshot(await this.deps.open(ref.spaceId!), ref, timestamp(this.deps)),
          focusVisible: async (ref, focus) => (await entityRun(await this.deps.open(ref.spaceId!), ref.id)).graph.nodes.some(node => node.id === focus),
          commandExists: (commandId) => this.commandExists(commandId),
        })
        for (const block of normalized.blocks) {
          const refs = block.type === 'entity' ? [{ ref: block.ref, snapshot: block.snapshot }] : block.type === 'pick' ? block.items : []
          for (const { ref, snapshot } of refs) {
            const href = ref.type === 'requirement' ? links.requirement(ref.spaceId!, ref.id) : ref.type === 'run' ? links.run(ref.spaceId!, ref.id) : ref.type === 'node' ? links.run(ref.spaceId!, ref.parent!, ref.id) : ref.type === 'workflow' ? links.workflow(ref.spaceId!, ref.id) : ref.type === 'knowledge' ? links.knowledge(ref.spaceId!, ref.id) : links.overview(ref.spaceId!)
            cite(snapshot.title, href, ref.type)
          }
        }
        await context.onBlocks?.(normalized.blocks)
        // 只回本次新增块的摘要（之前的块模型已经见过）
        data = { shown: normalized.blocks.length, issues: normalized.issues, content: describeBlocks(normalized.blocks.slice(current.length)) }
        break
      }
      case 'propose': {
        const proposal = await this.proposals.create(
          context.threadId,
          String(input.title),
          String(input.summary),
          input.steps as ProposalStep[],
        )
        context.proposals.push(proposal.id)
        data = proposal
        cite(
          '变更提案',
          `${links.home}?thread=${encodeURIComponent(context.threadId)}&proposal=${encodeURIComponent(proposal.id)}`,
        )
        break
      }
      case 'ask_lead':
        data = await this.askLead(spaceId!, reqId!, String(input.message), context)
        cite('需求群聊', links.requirement(spaceId!, reqId!, 'chat'), 'requirement')
        break
      default:
        throw new StewardError(400, '未知工具，请选择已注册工具')
    }
    return {
      data,
      citations,
      summary:
        name === 'show'
          ? `${TOOL_LABELS.show}：${(data as { shown: number }).shown} 个块`
          : `${TOOL_LABELS[name] ?? name}：返回 ${Array.isArray(data) ? data.length : data === undefined ? 0 : 1} 条`,
    }
  }
  private resolveSpace(name: string, spaces: Awaited<ReturnType<StewardDeps['spaces']>>) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*@\d{8}-\d{6}$/.test(name)) {
      return {
        query: name,
        exact: true,
        space: { id: name, name, requirements: 0, active: 0, archived: true },
        candidates: [{ space: { id: name, name, requirements: 0, active: 0, archived: true }, score: 1, match: 'id' }],
        instruction: '这是归档空间 ID，可用于 space.delete；删除仍必须生成高风险提案并由人批准。',
      }
    }
    const matches = this.matchSpaces(name, spaces)
    const exact = matches.find((item) => item.match === 'id' || item.match === 'name')
    return {
      query: name,
      exact: Boolean(exact),
      space: exact?.space,
      candidates: matches.slice(0, 5),
      instruction: exact
        ? '可以使用 space.id 继续查询。'
        : '未在可见空间中找到用户点名的空间；请明确说明没找到或可能无权限，并列出 candidates，不要用其他空间代答。',
    }
  }
  private resolveRequirement(name: string, requirements: Array<{ id: string; title: string }>) {
    const matches = this.matchRequirements(name, requirements)
    const exact = matches.find((item) => item.match === 'id' || item.match === 'title')
    return {
      query: name,
      exact: Boolean(exact),
      requirement: exact?.requirement,
      candidates: matches.slice(0, 5),
      instruction: exact
        ? '可以使用 requirement.id 继续查询。'
        : '未在该空间可见需求中找到用户点名的需求；请明确说明没找到或可能无权限，并列出 candidates，不要用其他需求代答。',
    }
  }
  private async presetBlocks(raw: unknown, currentSpaceId?: string): Promise<StewardBlock[]> {
    if (!raw || typeof raw !== 'object' || !('preset' in raw)) return []
    const input = raw as { preset?: unknown; spaceId?: unknown; requirementId?: unknown }
    const preset = input.preset
    const spaceId = typeof input.spaceId === 'string' && input.spaceId ? stewardId(input.spaceId) : currentSpaceId
    if (preset === 'space_progress') return spaceId ? this.spaceProgressBlocks(spaceId) : []
    if (preset === 'requirement_progress') {
      if (!spaceId || typeof input.requirementId !== 'string') return []
      return this.requirementProgressBlocks(spaceId, stewardId(input.requirementId))
    }
    if (preset === 'risks') return this.riskBlocks(spaceId)
    if (preset === 'attention') return this.attentionBlocks(spaceId)
    return []
  }
  /** 口径与总览一致：需求状态由最新流水线运行推导，Token 为全部需求累计。 */
  private async spaceProgressBlocks(spaceId: string): Promise<StewardBlock[]> {
    const space = await this.deps.open(spaceId),
      requirements = (await space.stores.workspaces.listRequirements()).filter((req) => req.status !== 'archived'),
      attention = await space.stores.attention.list({ pending: true }),
      lanes = await Promise.all(requirements.map((req) => this.requirementLane(space, req.id, req.title, req.status)))
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    for (const lane of lanes) usage = addUsage(usage, lane.usage)
    const count = (status: string) => lanes.filter((lane) => lane.status === status).length
    const blocked = count('blocked')
    return [
      {
        type: 'stats',
        title: '空间进度',
        items: [
          { label: '进行中', value: count('active'), tone: count('active') ? 'running' : 'neutral' },
          { label: '等你', value: attention.length, tone: attention.length ? 'waiting' : 'neutral' },
          { label: '阻塞', value: blocked, tone: blocked ? 'failed' : 'neutral' },
          { label: '已交付', value: count('delivered'), tone: count('delivered') ? 'success' : 'neutral' },
          { label: '累计 Token', value: compactTokens(usage.inputTokens + usage.outputTokens) },
        ],
      },
      // 先看要处理的：等人 / 阻塞 / 进行中在前，已交付在后
      { type: 'lanes', title: '交付泳道', rows: lanes.sort((a, b) => laneRank(a) - laneRank(b)).map((lane) => lane.row) },
    ]
  }
  private async requirementProgressBlocks(spaceId: string, requirementId: string): Promise<StewardBlock[]> {
    const space = await this.deps.open(spaceId),
      req = await space.stores.workspaces.getRequirement(requirementId)
    if (!req) return []
    const lane = await this.requirementLane(space, req.id, req.title, req.status)
    const blocks: StewardBlock[] = [{ type: 'lanes', title: '需求进度', rows: [lane.row] }]
    const metrics = await createInsights(space.stores).metrics(req.id).catch(() => undefined)
    if (metrics?.acCoverage?.length)
      blocks.push({ type: 'checklist', title: '验收标准', items: metrics.acCoverage.map((ac) => ({ label: `${ac.ac} ${ac.title}`, done: ac.status === 'covered', hint: `${ac.passed}/${ac.cases} 已验证`, ref: { type: 'requirement', spaceId, id: req.id, label: req.title } })) })
    const runs = (await space.stores.runs.list({ requirementId: req.id })).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    const events = (
      await Promise.all(
        runs.slice(0, 3).map(async (run) => {
          const titles = new Map((await space.stores.runs.getWorkflow(run.runId))?.nodes.map((node) => [node.id, node.title || node.id]) ?? [])
          return (await space.stores.events.read(run.runId).catch(() => []))
            .map((event) => ({ event, run, item: timelineItem(event, titles) }))
            .filter((entry) => entry.item)
        }),
      )
    )
      .flat()
      .sort((a, b) => b.event.ts.localeCompare(a.event.ts))
      .slice(0, 6)
    if (events.length)
      blocks.push({ type: 'timeline', title: '最近动态', items: events.map(({ event, run, item }) => ({ at: event.ts, ...item!, ref: { type: 'run', spaceId, id: run.runId, label: run.runId } })) })
    return blocks
  }
  private async riskBlocks(spaceId?: string): Promise<StewardBlock[]> {
    const risks = (await refreshRisks(this.deps, this.store)).filter((risk) => risk.state === 'open' && (!spaceId || risk.spaceId === spaceId))
    if (!risks.length) return [{ type: 'callout', tone: 'success', title: '暂无风险', body: '没有需要你处理的风险。' }]
    return [{ type: 'table', title: '当前风险', columns: [{ key: 'risk', label: '风险' }, { key: 'level', label: '级别' }, { key: 'requirement', label: '需求', mono: true }, { key: 'suggestion', label: '建议' }], rows: risks.map((risk) => ({ risk: risk.title, level: RISK_LEVEL[risk.level] ?? risk.level, requirement: risk.requirementId ?? null, suggestion: risk.actions[0]?.label ?? risk.detail })), refs: risks.map((risk) => risk.requirementId ? { type: 'requirement', spaceId: risk.spaceId, id: risk.requirementId, label: risk.requirementId } : { type: 'space', id: risk.spaceId, label: risk.spaceId }) }]
  }
  private async attentionBlocks(spaceId?: string): Promise<StewardBlock[]> {
    const spaces = spaceId ? [await this.deps.open(spaceId)] : await Promise.all((await this.deps.spaces()).map((space) => this.deps.open(space.id))),
      items = (await Promise.all(spaces.map(async (space) => (await space.stores.attention.list({ pending: true })).map((item) => ({ ...item, spaceId: space.id }))))).flat()
    if (!items.length) return [{ type: 'callout', tone: 'success', title: '没有待办', body: '暂时没有等你决定的事。' }]
    return [
      { type: 'checklist', title: '等你决定', items: items.map((item) => ({ label: item.ask, done: false, hint: `${item.requirementId} · ${FORM_LABEL[item.form] ?? item.form}`, ref: { type: 'requirement', spaceId: item.spaceId, id: item.requirementId, label: item.requirementId } })) },
      ...(spaces[0] ? [{ type: 'actions' as const, items: [{ kind: 'open' as const, label: '去处理', ref: { type: 'space' as const, id: spaceId ?? spaces[0].id, label: '待办' }, primary: true }] }] : []),
    ]
  }
  /** 与总览同一套推导：只看流水线运行（排除 Lead 任务），需求状态用 deriveRequirementState。 */
  private async requirementLane(space: StewardSpace, requirementId: string, title: string, stored: string): Promise<{ row: Extract<StewardBlock, { type: 'lanes' }>['rows'][number]; status: string; waiting: number; usage: Usage }> {
    const { runs, attention, detail, status } = await requirementState(space, requirementId)
    const ref = { type: 'requirement' as const, spaceId: space.id, id: requirementId, label: title }
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    for (const run of runs) usage = addUsage(usage, await this.runUsage(space, run))
    return { row: { title, ref, stages: detail?.stages.map(stage => ({ label: stage.title, status: stageStatus(stage.status) })) ?? [], note: attention[0] ? `等你：${attention[0].ask}` : detail ? undefined : '尚未运行', tone: attention.length ? 'waiting' : detail ? stateTone(detail.run.status) : stateTone(stored) }, status, waiting: attention.length, usage }
  }
  private async runUsage(space: StewardSpace, run: RunState): Promise<Usage> {
    const events = await space.stores.events.read(run.runId).catch(() => [])
    return events.length ? summarizeUsage(events) : Object.values(run.nodes).reduce((total, node) => node.usage ? addUsage(total, node.usage) : total, { inputTokens: 0, outputTokens: 0 })
  }
  private async refVisible(ref: StewardContextRef): Promise<boolean> {
    if (ref.type !== 'file') return Boolean(await resolveEntityRef(this.deps, ref))
    if (!ref.spaceId || !(await this.deps.spaces()).some(space => space.id === ref.spaceId)) return false
    return (await readStewardFile((await this.deps.open(ref.spaceId)).dir, ref.id)) !== undefined
  }
  private async commandExists(commandId: string): Promise<boolean> {
    if ((this.deps.serverCommands?.list() ?? []).some((command) => command.id === commandId)) return true
    for (const space of await this.deps.spaces())
      if ((await this.deps.open(space.id)).commands.list().some((command) => command.id === commandId)) return true
    return false
  }
  private matchRequirements(name: string, requirements: Array<{ id: string; title: string }>) {
    const query = name.trim().toLowerCase()
    const score = (value: string, exactKind: 'id' | 'title'): { score: number; match: 'id' | 'title' | 'contains' | 'fuzzy' } | undefined => {
      const text = value.toLowerCase()
      if (text === query) return { score: 1, match: exactKind }
      if (text.includes(query) || query.includes(text)) return { score: 0.75, match: 'contains' }
      let pos = 0
      for (const char of query) {
        pos = text.indexOf(char, pos)
        if (pos === -1) return undefined
        pos++
      }
      return { score: 0.45, match: 'fuzzy' }
    }
    return requirements
      .map((requirement) => {
        const byId = score(requirement.id, 'id'),
          byTitle = score(requirement.title, 'title'),
          best = !byTitle || (byId && byId.score >= byTitle.score) ? byId : byTitle
        return best ? { requirement, score: best.score, match: best.match } : undefined
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => b.score - a.score || a.requirement.id.localeCompare(b.requirement.id))
  }
  private matchSpaces(name: string, spaces: Awaited<ReturnType<StewardDeps['spaces']>>) {
    const query = name.trim().toLowerCase()
    const score = (value: string, exactKind: 'id' | 'name'): { score: number; match: 'id' | 'name' | 'contains' | 'fuzzy' } | undefined => {
      const text = value.toLowerCase()
      if (text === query) return { score: 1, match: exactKind }
      if (text.includes(query) || query.includes(text)) return { score: 0.75, match: 'contains' }
      let pos = 0
      for (const char of query) {
        pos = text.indexOf(char, pos)
        if (pos === -1) return undefined
        pos++
      }
      return { score: 0.45, match: 'fuzzy' }
    }
    return spaces
      .map((space) => {
        const byId = score(space.id, 'id'),
          byName = score(space.name, 'name'),
          best = !byName || (byId && byId.score >= byName.score) ? byId : byName
        return best ? { space, score: best.score, match: best.match } : undefined
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => b.score - a.score || a.space.id.localeCompare(b.space.id))
  }
  private workflowView(doc: WorkflowDocument, includeSource: boolean) {
    const literal = (value: unknown): unknown =>
      value && typeof value === 'object' && 'kind' in value && (value as { kind?: unknown }).kind === 'literal'
        ? (value as unknown as { value: unknown }).value
        : undefined
    const fromModel = (nodes: WorkflowDocument['model']['nodes'], parent?: string): unknown[] =>
      nodes.flatMap((node) => {
        const props = node.props,
          row = {
            id: node.id,
            kind: node.kind,
            title: String(literal(props.title) ?? node.id),
            stage: literal(props.stage),
            needs: Array.isArray(literal(props.needs)) ? literal(props.needs) : [],
            parent,
          }
        return [row, ...(node.body ? fromModel(node.body, node.id) : [])]
      })
    const fromSnapshot = (nodes: SnapshotNode[], parent?: string): unknown[] =>
      nodes.flatMap((node) => [
        { id: node.id, kind: node.kind, title: node.title, stage: node.stage, needs: node.needs, parent },
        ...(node.body ? fromSnapshot(node.body, node.id) : []),
      ])
    const stages = doc.snapshot?.stages ?? literal(doc.model.stages) ?? []
    return {
      id: doc.id,
      file: doc.file,
      rev: doc.rev,
      editable: doc.model.editable,
      diagnostics: doc.diagnostics,
      stages,
      nodes: doc.snapshot ? fromSnapshot(doc.snapshot.nodes) : fromModel(doc.model.nodes),
      editOps: [
        'addNode：新增节点，字段 kind 和 props（props.id/title/needs/stage 等用 EditableValue）',
        'removeNode：删除节点，同时清理字面量 needs',
        'setProp：设置或删除节点属性，value=null 表示删除',
        'setNeeds：替换节点依赖',
        'moveNode：移动节点位置',
        'setStages：替换阶段列表',
        'setMeta / setMetaValue：修改流程元信息',
      ],
      source: includeSource
        ? doc.source.length > 16 * 1024
          ? `${doc.source.slice(0, 16 * 1024)}\n/* truncated */`
          : doc.source
        : undefined,
    }
  }
  private delegationFile(messageId: string): string { return `delegations/${sha256(messageId)}.json` }

  private async saveDelegation(record: DelegationRecord, context?: ToolContext): Promise<void> {
    await this.store.write(this.delegationFile(record.delegation.messageId), record)
    if (context) await context.onDelegation?.({ ...record.delegation })
    for (const message of await this.store.messages(record.threadId)) {
      if (!message.delegations?.some(item => item.messageId === record.delegation.messageId)) continue
      message.delegations = message.delegations.map(item => item.messageId === record.delegation.messageId ? { ...record.delegation } : item)
      await this.store.saveMessage(message)
      this.store.emit(record.threadId, { type: 'delegation', messageId: message.id, delegation: { ...record.delegation } })
    }
    await this.store.feed({ type: 'delegation', at: timestamp(this.deps), threadId: record.threadId, delegation: { ...record.delegation } })
  }

  async refreshDelegations(): Promise<StewardDelegation[]> {
    // 把旧消息里的 answered / failed 归一化；旧消息仍可用于显式重发。
    for (const thread of await this.store.threads()) for (const message of await this.store.messages(thread.id)) {
      for (const delegation of message.delegations ?? []) if (!(await this.store.read(this.delegationFile(delegation.messageId)))) {
        const space = await this.deps.open(delegation.spaceId)
        const original = (await space.stores.chat.list(delegation.requirementId)).find(item => item.id === delegation.messageId)
        await this.store.write(this.delegationFile(delegation.messageId), { delegation: { ...delegation }, threadId: thread.id, text: original?.text ?? '', sentAt: delegation.at } satisfies DelegationRecord)
      }
    }
    const results: StewardDelegation[] = []
    for (const record of await this.store.list<DelegationRecord>('delegations')) {
      const before = JSON.stringify(record.delegation)
      const delegation = record.delegation
      delegation.status = delegationStatus(delegation.status)
      const space = await this.deps.open(delegation.spaceId)
      for (const message of await space.stores.chat.list(delegation.requirementId)) {
        if (message.replyTo !== delegation.messageId || message.author.type !== 'agent' || message.author.role !== 'lead') continue
        if (message.receipt?.status === 'taken' && ['sent', 'uncertain', 'expired'].includes(delegation.status)) {
          delegation.status = 'taken'; delegation.at = message.at
        } else if (message.receipt?.status === 'replied' || !message.receipt && message.kind === 'text') {
          delegation.status = 'replied'; delegation.reply = message.text; delegation.at = message.at
        } else if (message.receipt?.status === 'refused') {
          delegation.status = 'refused'; delegation.reply = message.text; delegation.at = message.at
        }
      }
      if (delegation.status === 'sent' && Date.parse(timestamp(this.deps)) - Date.parse(record.sentAt) >= DEFAULT_RECEIPT_TIMEOUT_MINUTES * 60_000) {
        delegation.status = 'expired'; delegation.at = timestamp(this.deps)
      }
      if (before !== JSON.stringify(delegation)) await this.saveDelegation(record)
      results.push({ ...delegation })
    }
    return results
  }

  async resendDelegation(messageId: string, reason: string): Promise<StewardDelegation> {
    if (!reason.trim()) throw new StewardError(400, '重发必须填写原因，请补充后重试')
    await this.refreshDelegations()
    const record = await this.store.read<DelegationRecord>(this.delegationFile(messageId))
    if (!record || !['uncertain', 'expired'].includes(delegationStatus(record.delegation.status))) throw new StewardError(409, '仅不确定或已过期的转达可重发，请刷新回执')
    if (!record.text) throw new StewardError(409, '旧转达缺少原文，请人工重新发起')
    const result = await this.askLead(record.delegation.spaceId, record.delegation.requirementId, record.text,
      { threadId: record.threadId, messageId: randomUUID(), proposals: [], delegations: [] })
    await this.store.append('delegation-audit.jsonl', { action: 'resend', messageId, newMessageId: result.messageId, reason, at: timestamp(this.deps) })
    return result
  }

  private async askLead(spaceId: string, requirementId: string, text: string, context: ToolContext): Promise<StewardDelegation> {
    const space = await this.deps.open(spaceId)
    if (!(await space.stores.workspaces.getRequirement(requirementId))) throw new StewardError(404, '需求不存在，请检查引用')
    const delegation: StewardDelegation = { spaceId, requirementId, messageId: `uncertain-${randomUUID()}`, status: 'sent', at: timestamp(this.deps) }
    const record: DelegationRecord = { delegation, threadId: context.threadId, text, sentAt: delegation.at }
    context.delegations.push(delegation)
    let resolveWait!: (delegation: StewardDelegation) => void
    const wait = new Promise<StewardDelegation>(resolve => { resolveWait = resolve })
    let sent = false, finished = false
    let waitTimer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined
    const pending: RoomMessage[] = []
    let updates = Promise.resolve()
    const receive = (message: RoomMessage) => {
      if (!sent) { pending.push(message); return }
      if (message.replyTo !== delegation.messageId || message.author.type !== 'agent' || message.author.role !== 'lead') return
      updates = updates.then(async () => {
        if (finished) return
        if (message.receipt?.status === 'taken') { delegation.status = 'taken'; clearTimeout(expiryTimer) }
        else if (message.receipt?.status === 'replied' || !message.receipt && message.kind === 'text') {
          delegation.status = 'replied'; delegation.reply = message.text; finished = true
        } else if (message.receipt?.status === 'refused') { delegation.status = 'refused'; delegation.reply = message.text; finished = true }
        else return
        delegation.at = message.at
        await this.saveDelegation(record, context)
        if (finished) { cleanup(); resolveWait(delegation) }
      }).catch(error => {
        delegation.status = 'uncertain'; delegation.reply = `回执保存失败：${String(error)}`
        cleanup(); resolveWait(delegation)
      })
    }
    const unsubscribe = space.onChat(requirementId, receive)
    const cleanup = () => { unsubscribe(); clearTimeout(waitTimer); clearTimeout(expiryTimer); this.cleanups.delete(cleanup) }
    this.cleanups.add(cleanup)
    try {
      delegation.messageId = await space.postToLead(requirementId, `${text}\n\n来源：/solo?thread=${context.threadId}`)
      sent = true
    } catch (error) {
      delegation.status = 'uncertain'; delegation.reply = `发送结果不确定：${String(error)}；请检查群聊后决定是否重发`
      await this.saveDelegation(record, context)
      cleanup()
      return delegation
    }
    await this.saveDelegation(record, context)
    for (const message of pending) receive(message)
    waitTimer = setTimeout(() => resolveWait(delegation), Math.min(60000, this.deps.leadTimeoutMs ?? 60000))
    expiryTimer = setTimeout(() => {
      updates = updates.then(async () => {
        if (delegation.status !== 'sent') return
        delegation.status = 'expired'; delegation.at = timestamp(this.deps)
        await this.saveDelegation(record, context)
        cleanup(); resolveWait(delegation)
      }).catch(() => { cleanup(); resolveWait(delegation) })
    }, DEFAULT_RECEIPT_TIMEOUT_MINUTES * 60_000)
    expiryTimer.unref()
    return wait
  }
}
