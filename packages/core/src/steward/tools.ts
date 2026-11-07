import type { StewardCitation, StewardDelegation, ProposalStep } from '../api.js'
import type { ToolSpec, RoomMessage } from '../types.js'
import { createInsights } from '../insights/fs-insights.js'
import { stageProgress } from '../insights/graph.js'
import { budgetStatus } from '../insights/budget.js'
import { scorecards } from '../eval/scorecards.js'
import { validateSchema } from '../engine/schema.js'
import { type StewardDeps, type StewardSpace, stewardId, timestamp, StewardError } from './contracts.js'
import { StewardStore } from './store.js'
import { stewardLinks as links } from './links.js'
import { readStewardFile, redactSecrets } from './files.js'
import { StewardProposals } from './proposals.js'
import { refreshRisks } from './risks.js'
import { productMetrics } from './metrics.js'

export interface StewardToolResult { data: unknown; citations: StewardCitation[]; summary: string }
export interface ToolContext { threadId: string; messageId: string; proposals: string[]; delegations: StewardDelegation[]; onDelegation?: (delegation: StewardDelegation) => Promise<void> }
export class StewardTools {
  private readonly cleanups = new Set<() => void>()
  constructor(readonly deps: StewardDeps, readonly store: StewardStore, readonly userId: string, readonly proposals: StewardProposals) {}
  close(): void { for (const cleanup of this.cleanups) cleanup(); this.cleanups.clear() }
  async restoreDelegations(): Promise<void> {
    for (const thread of await this.store.threads()) for (const message of await this.store.messages(thread.id)) {
      for (const delegation of message.delegations ?? []) {
        if (delegation.status !== 'sent') continue
        let space: StewardSpace
        try { space = await this.deps.open(delegation.spaceId) } catch (error) {
          if (!(error instanceof StewardError) || ![403, 404].includes(error.status)) throw error
          delegation.status = 'failed'; delegation.reply = '原空间已不可访问，请检查权限或空间是否已归档'
          await this.store.saveMessage(message)
          continue
        }
        let answered = false
        const receive = (reply: RoomMessage) => {
          if (answered || reply.replyTo !== delegation.messageId || reply.author.type !== 'agent' || reply.author.role !== 'lead') return
          answered = true; cleanup()
          void this.store.serial(async () => {
            const latest = (await this.store.messages(thread.id)).find((item) => item.id === message.id)!
            const current = latest.delegations?.find((item) => item.messageId === delegation.messageId)
            if (!current || current.status !== 'sent') return
            Object.assign(current, { status: 'answered', reply: reply.text, at: reply.at })
            await this.store.saveMessage(latest)
            this.store.emit(thread.id, { type: 'delegation', messageId: message.id, delegation: current })
            await this.store.feed({ type: 'delegation', at: timestamp(this.deps), threadId: thread.id, delegation: current })
          }).catch((error: unknown) => { this.store.emit(thread.id, { type: 'error', messageId: message.id, error: `转达回填失败，请刷新会话：${String(error)}` }) })
        }
        const off = space.onChat(delegation.requirementId, receive)
        const cleanup = () => { off(); this.cleanups.delete(cleanup) }
        this.cleanups.add(cleanup)
        for (const reply of await space.stores.chat.list(delegation.requirementId)) receive(reply)
      }
    }
  }
  async specs(): Promise<ToolSpec[]> {
    const str = { type: 'string' }, object = { type: 'object' }
    const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
      ['list_spaces', '列出可见空间', {}, []],
      ['space_overview', '空间需求、运行与待办总览', { spaceId: str }, ['spaceId']],
      ['list_requirements', '列出空间需求，可按状态筛选', { spaceId: str, status: str }, ['spaceId']],
      ['requirement_status', '需求阶段、当前节点、待办、预算与档位', { spaceId: str, requirementId: str }, ['spaceId', 'requirementId']],
      ['run_status', '运行状态', { spaceId: str, runId: str }, ['spaceId', 'runId']],
      ['list_attention', '查询待处理事项', { spaceId: str }, []],
      ['list_risks', '查询当前风险', { spaceId: str }, []],
      ['get_metrics', '查询需求指标或产品健康', { spaceId: str, requirementId: str }, []],
      ['workflow_get', '读取 workflow 源码、可编辑模型、诊断和修订', { spaceId: str, workflowId: str }, ['spaceId', 'workflowId']],
      ['get_config', '读取已脱敏的空间配置', { spaceId: str }, ['spaceId']],
      ['eval_scorecards', '查询成绩单与退化', { spaceId: str }, ['spaceId']],
      ['list_commands', '列出命令及参数格式', { spaceId: str }, []],
      ['read_file', '读取空间内非敏感文件，最多 64KB', { spaceId: str, path: str }, ['spaceId', 'path']],
      ['propose', '生成变更提案；写操作必须使用此工具', { title: str, summary: str, steps: { type: 'array', items: object } }, ['title', 'summary', 'steps']],
      ['ask_lead', '将需求内部任务转达给 Lead，等待或异步回填', { spaceId: str, requirementId: str, message: str }, ['spaceId', 'requirementId', 'message']],
    ]
    for (const space of await this.deps.spaces()) if ((await this.deps.open(space.id)).stores.kb) {
      definitions.push(['knowledge_search', '在已接入的知识库中检索', { spaceId: str, text: str, bases: { type: 'array', items: str } }, ['spaceId', 'text']]); break
    }
    return definitions.map(([name, description, properties, required]) => ({ name, description, parameters: { type: 'object', properties, required } }))
  }
  async call(name: string, input: Record<string, unknown>, context: ToolContext): Promise<StewardToolResult> {
    const spec = (await this.specs()).find((tool) => tool.name === name)
    if (!spec) throw new StewardError(400, '工具未接入，请选择可用工具')
    try { validateSchema(input, spec.parameters) } catch (error) { throw new StewardError(400, `工具参数错误，请修正：${String(error)}`) }
    const spaceId = typeof input.spaceId === 'string' ? stewardId(input.spaceId) : undefined
    const space = spaceId ? await this.deps.open(spaceId) : undefined
    const citations: StewardCitation[] = []
    let data: unknown
    const cite = (label: string, href: string, kind?: StewardCitation['kind']) => citations.push({ label, href, kind })
    const reqId = typeof input.requirementId === 'string' ? stewardId(input.requirementId) : undefined
    switch (name) {
      case 'list_spaces': data = await this.deps.spaces(); cite('空间列表', links.spaces, 'space'); break
      case 'space_overview':
        data = { space: (await this.deps.spaces()).find((s) => s.id === spaceId), requirements: await space!.stores.workspaces.listRequirements(), runs: await space!.stores.runs.list(), attention: await space!.stores.attention.list({ pending: true }) }
        cite(space!.name, links.overview(spaceId!), 'space'); break
      case 'list_requirements': data = (await space!.stores.workspaces.listRequirements()).filter((r) => input.status ? r.status === input.status : r.status !== 'archived'); cite('需求列表', links.overview(spaceId!), 'space'); break
      case 'requirement_status': {
        const req = await space!.stores.workspaces.getRequirement(reqId!)
        if (!req) throw new StewardError(404, '需求不存在，请检查引用')
        const run = (await space!.stores.runs.list({ requirementId: reqId })).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
        const snapshot = run ? await space!.stores.runs.getWorkflow(run.runId) : undefined
        data = { requirement: req, stages: run && snapshot ? stageProgress(snapshot, run) : [], currentNodes: run ? Object.values(run.nodes).filter((n) => ['running', 'waiting_human', 'blocked'].includes(n.status)) : [],
          attention: await space!.stores.attention.list({ requirementId: reqId, pending: true }), latestRun: run, tier: run?.route?.tier,
          budget: run ? budgetStatus({ ...run, endedAt: run.endedAt ?? timestamp(this.deps) }, await space!.stores.events.read(run.runId)) : undefined }
        cite(req.title, links.requirement(spaceId!, req.id), 'requirement'); break
      }
      case 'run_status': {
        const run = await space!.stores.runs.get(stewardId(String(input.runId)))
        if (!run) throw new StewardError(404, '运行不存在，请检查引用')
        data = { run, events: (await space!.stores.events.read(run.runId)).slice(-20) }; cite(run.runId, links.run(spaceId!, run.runId), 'run'); break
      }
      case 'list_attention': {
        const spaces = space ? [space] : await Promise.all((await this.deps.spaces()).map((s) => this.deps.open(s.id)))
        data = (await Promise.all(spaces.map(async (s) => {
          cite(`${s.name} 待办`, links.attention(s.id), 'attention')
          return (await s.stores.attention.list({ pending: true })).map((item) => ({ ...item, spaceId: s.id }))
        }))).flat(); break
      }
      case 'list_risks': {
        const risks = (await refreshRisks(this.deps, this.store)).filter((risk) => risk.state === 'open' && (!spaceId || risk.spaceId === spaceId))
        data = risks
        for (const risk of risks) for (const evidence of risk.evidence) cite(evidence.label, evidence.href, 'risk')
        if (!risks.length) cite('风险列表', links.home, 'risk')
        break
      }
      case 'get_metrics': data = space && reqId ? await createInsights(space.stores).metrics(reqId) : await productMetrics(this.deps, this.store); cite('指标', spaceId && reqId ? links.requirement(spaceId, reqId, 'metrics') : links.home); break
      case 'workflow_get': data = await space!.workflows.get(stewardId(String(input.workflowId))); cite(String(input.workflowId), links.workflow(spaceId!, String(input.workflowId)), 'workflow'); break
      case 'get_config': data = redactSecrets(space!.stores.config); cite('空间设置', links.settings(spaceId!, 'general')); break
      case 'eval_scorecards': data = await scorecards(space!.stores, { by: 'node' }); cite('成绩单', `${links.overview(spaceId!)}/eval`); break
      case 'list_commands': data = (space ? space.commands.list() : this.deps.serverCommands?.list() ?? []).filter((c) => !c.id.startsWith('steward.')); cite('命令', links.home); break
      case 'read_file': data = { path: input.path, content: await readStewardFile(space!.dir, String(input.path)) }; cite(String(input.path), `${links.overview(spaceId!)}/files?path=${encodeURIComponent(String(input.path))}`, 'file'); break
      case 'knowledge_search': {
        if (!space!.stores.kb) throw new StewardError(400, '当前空间尚未接入知识库，请先创建知识库')
        const result = await space!.stores.kb.route({ text: String(input.text), bases: input.bases as string[] | undefined }, { role: 'steward', bases: input.bases as string[] | undefined })
        data = result
        for (const hit of result.hits) cite(hit.title ?? hit.ref, links.knowledge(spaceId!, hit.baseId ?? result.bases[0]?.id ?? ''), 'knowledge')
        break
      }
      case 'propose': {
        const proposal = await this.proposals.create(context.threadId, String(input.title), String(input.summary), input.steps as ProposalStep[])
        context.proposals.push(proposal.id); data = proposal
        cite('变更提案', `${links.home}?thread=${encodeURIComponent(context.threadId)}&proposal=${encodeURIComponent(proposal.id)}`)
        break
      }
      case 'ask_lead': data = await this.askLead(spaceId!, reqId!, String(input.message), context); cite('需求群聊', links.requirement(spaceId!, reqId!, 'chat'), 'requirement'); break
      default: throw new StewardError(400, '未知工具，请选择已注册工具')
    }
    return { data, citations, summary: `${spec.description}：返回 ${Array.isArray(data) ? data.length : data === undefined ? 0 : 1} 条` }
  }
  private async askLead(spaceId: string, requirementId: string, text: string, context: ToolContext): Promise<StewardDelegation> {
    const space = await this.deps.open(spaceId)
    if (!await space.stores.workspaces.getRequirement(requirementId)) throw new StewardError(404, '需求不存在，请检查引用')
    const delegation: StewardDelegation = { spaceId, requirementId, messageId: '', status: 'sent', at: timestamp(this.deps) }
    let settled = false, resolveWait: (value: StewardDelegation) => void = () => {}, timer: ReturnType<typeof setTimeout> | undefined
    const wait = new Promise<StewardDelegation>((resolve) => { resolveWait = resolve })
    const pending: RoomMessage[] = []
    const receive = (message: RoomMessage) => {
      if (!delegation.messageId) { pending.push(message); return }
      if (settled || message.author.type !== 'agent' || message.author.role !== 'lead' || message.replyTo !== delegation.messageId) return
      settled = true; cleanup()
      delegation.status = 'answered'; delegation.reply = message.text; delegation.at = message.at
      void (async () => {
        await context.onDelegation?.(delegation)
        await this.store.feed({ type: 'delegation', at: timestamp(this.deps), threadId: context.threadId, delegation })
        resolveWait(delegation)
      })().catch((error: unknown) => { delegation.status = 'failed'; delegation.reply = `回填失败：${String(error)}`; resolveWait(delegation) })
    }
    const unsubscribe = space.onChat(requirementId, receive)
    const cleanup = () => { unsubscribe(); clearTimeout(timer); this.cleanups.delete(cleanup) }
    this.cleanups.add(cleanup)
    try { delegation.messageId = await space.postToLead(requirementId, `${text}\n\n来源：/steward?thread=${context.threadId}`) } catch (error) { cleanup(); throw error }
    context.delegations.push(delegation)
    try { await context.onDelegation?.({ ...delegation }) } catch (error) { cleanup(); throw error }
    for (const message of pending) receive(message)
    if (!settled) timer = setTimeout(() => resolveWait(delegation), Math.min(60000, this.deps.leadTimeoutMs ?? 60000))
    return wait
  }
}
