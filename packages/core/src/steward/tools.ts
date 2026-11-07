import type { StewardCitation, StewardDelegation, ProposalStep, WorkflowDocument } from '../api.js'
import type { ToolSpec, RoomMessage, NodeKind, SnapshotNode } from '../types.js'
import { createInsights } from '../insights/fs-insights.js'
import { stageProgress } from '../insights/graph.js'
import { budgetStatus } from '../insights/budget.js'
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


/** 界面上的工具名：description 是写给模型的长约束，不适合直接展示在工具卡片里。 */
const TOOL_LABELS: Record<string, string> = {
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
}
export interface StewardToolResult {
  data: unknown
  citations: StewardCitation[]
  summary: string
}
export interface ToolContext {
  threadId: string
  messageId: string
  proposals: string[]
  delegations: StewardDelegation[]
  onDelegation?: (delegation: StewardDelegation) => Promise<void>
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
    for (const thread of await this.store.threads())
      for (const message of await this.store.messages(thread.id)) {
        for (const delegation of message.delegations ?? []) {
          if (delegation.status !== 'sent') continue
          let space: StewardSpace
          try {
            space = await this.deps.open(delegation.spaceId)
          } catch (error) {
            if (!(error instanceof StewardError) || ![403, 404].includes(error.status)) throw error
            delegation.status = 'failed'
            delegation.reply = '原空间已不可访问，请检查权限或空间是否已归档'
            await this.store.saveMessage(message)
            continue
          }
          let answered = false
          const receive = (reply: RoomMessage) => {
            if (
              answered ||
              reply.replyTo !== delegation.messageId ||
              reply.author.type !== 'agent' ||
              reply.author.role !== 'lead'
            )
              return
            answered = true
            cleanup()
            void this.store
              .serial(async () => {
                const latest = (await this.store.messages(thread.id)).find(
                  (item) => item.id === message.id,
                )!
                const current = latest.delegations?.find(
                  (item) => item.messageId === delegation.messageId,
                )
                if (!current || current.status !== 'sent') return
                Object.assign(current, { status: 'answered', reply: reply.text, at: reply.at })
                await this.store.saveMessage(latest)
                this.store.emit(thread.id, {
                  type: 'delegation',
                  messageId: message.id,
                  delegation: current,
                })
                await this.store.feed({
                  type: 'delegation',
                  at: timestamp(this.deps),
                  threadId: thread.id,
                  delegation: current,
                })
              })
              .catch((error: unknown) => {
                this.store.emit(thread.id, {
                  type: 'error',
                  messageId: message.id,
                  error: `转达回填失败，请刷新会话：${String(error)}`,
                })
              })
          }
          const off = space.onChat(delegation.requirementId, receive)
          const cleanup = () => {
            off()
            this.cleanups.delete(cleanup)
          }
          this.cleanups.add(cleanup)
          for (const reply of await space.stores.chat.list(delegation.requirementId)) receive(reply)
        }
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
    const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
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
    const space = spaceId ? await this.deps.open(spaceId) : undefined
    const citations: StewardCitation[] = []
    let data: unknown
    const cite = (label: string, href: string, kind?: StewardCitation['kind']) =>
      citations.push({ label, href, kind })
    const reqId =
      typeof input.requirementId === 'string' ? stewardId(input.requirementId) : undefined
    switch (name) {
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
        const run = (await space!.stores.runs.list({ requirementId: reqId })).sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt),
        )[0]
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
      summary: `${TOOL_LABELS[name] ?? name}：返回 ${Array.isArray(data) ? data.length : data === undefined ? 0 : 1} 条`,
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
  private async askLead(
    spaceId: string,
    requirementId: string,
    text: string,
    context: ToolContext,
  ): Promise<StewardDelegation> {
    const space = await this.deps.open(spaceId)
    if (!(await space.stores.workspaces.getRequirement(requirementId)))
      throw new StewardError(404, '需求不存在，请检查引用')
    const delegation: StewardDelegation = {
      spaceId,
      requirementId,
      messageId: '',
      status: 'sent',
      at: timestamp(this.deps),
    }
    let settled = false,
      resolveWait: (value: StewardDelegation) => void = () => {},
      timer: ReturnType<typeof setTimeout> | undefined
    const wait = new Promise<StewardDelegation>((resolve) => {
      resolveWait = resolve
    })
    const pending: RoomMessage[] = []
    const receive = (message: RoomMessage) => {
      if (!delegation.messageId) {
        pending.push(message)
        return
      }
      if (
        settled ||
        message.author.type !== 'agent' ||
        message.author.role !== 'lead' ||
        message.replyTo !== delegation.messageId
      )
        return
      settled = true
      cleanup()
      delegation.status = 'answered'
      delegation.reply = message.text
      delegation.at = message.at
      void (async () => {
        await context.onDelegation?.(delegation)
        await this.store.feed({
          type: 'delegation',
          at: timestamp(this.deps),
          threadId: context.threadId,
          delegation,
        })
        resolveWait(delegation)
      })().catch((error: unknown) => {
        delegation.status = 'failed'
        delegation.reply = `回填失败：${String(error)}`
        resolveWait(delegation)
      })
    }
    const unsubscribe = space.onChat(requirementId, receive)
    const cleanup = () => {
      unsubscribe()
      clearTimeout(timer)
      this.cleanups.delete(cleanup)
    }
    this.cleanups.add(cleanup)
    try {
      delegation.messageId = await space.postToLead(
        requirementId,
        `${text}\n\n来源：/steward?thread=${context.threadId}`,
      )
    } catch (error) {
      cleanup()
      throw error
    }
    context.delegations.push(delegation)
    try {
      await context.onDelegation?.({ ...delegation })
    } catch (error) {
      cleanup()
      throw error
    }
    for (const message of pending) receive(message)
    if (!settled)
      timer = setTimeout(
        () => resolveWait(delegation),
        Math.min(60000, this.deps.leadTimeoutMs ?? 60000),
      )
    return wait
  }
}
