import type { Risk, NodeScorecard } from '../api.js'
import type { AttentionItem, ProjectStores } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, Requirement, RunState } from '../types.js'
import { listDefects } from '../defects/index.js'
import { scorecards } from '../eval/scorecards.js'
import { budgetUsage } from '../util/budget.js'
import { stewardLinks } from '../steward/links.js'
import { runEventsOf, runLastEventAt } from './run-digest.js'

const RISK_EVENT_TYPES = ['harness.usage', 'retry.suppressed', 'review.exhausted', 'gate.result'] as const

export type ComputedRisk = Omit<Risk, 'state'>
export interface RiskThresholds { waitingMediumMs?: number; waitingHighMs?: number; stalledMs?: number; budgetMedium?: number; budgetHigh?: number; deadlineRatio?: number }
export interface RiskSnapshot {
  requirements: Requirement[]
  /** lastAt：最后一条事件的时间；给了就不必把全部事件传进来（events 可以只是风险要用的那几类）。 */
  runs: Array<{ run: RunState; events: EventEnvelope[]; lastAt?: string }>
  attention: AttentionItem[]
  defects?: Array<{ id: string; requirementId: string; title: string }>
  scorecards?: NodeScorecard[]
}
export function computeRiskSnapshot(snapshot: RiskSnapshot, spaceId: string, now: Date, thresholds: RiskThresholds = {}): ComputedRisk[] {
  const at = now.toISOString(), time = now.getTime(), risks: ComputedRisk[] = []
  const add = (kind: Risk['kind'], level: Risk['level'], req: string, subject: string, title: string, detail: string, runId?: string, nodeId?: string) => {
    const href = runId ? stewardLinks.run(spaceId, runId, nodeId) : req ? stewardLinks.requirement(spaceId, req) : stewardLinks.overview(spaceId)
    risks.push({ key: `${kind}:${spaceId}/${req}/${subject}`, kind, level, spaceId, ...(req ? { requirementId: req } : {}), runId, nodeId,
      title, detail, evidence: [{ label: title, href }], firstSeenAt: at, lastSeenAt: at, actions: [{ label: '让管家协助处理', ask: `帮我处理${title}`, href }] })
  }
  for (const item of snapshot.attention) {
    const age = time - Date.parse(item.createdAt)
    if (!item.answeredAt && age > (thresholds.waitingMediumMs ?? 4 * 3600000)) add('waiting-human', age > (thresholds.waitingHighMs ?? 24 * 3600000) ? 'high' : 'medium', item.requirementId, item.requestId, '待办等待过久', item.ask, item.runId, item.nodeId)
  }
  for (const { run, events, lastAt } of snapshot.runs) {
    const live = ['running', 'waiting_human'].includes(run.status)
    if (live) {
      const used = { tokens: 0, costUsd: 0, minutes: Math.max(0, (time - Date.parse(run.startedAt)) / 60000) }
      for (const event of events) if (event.type === 'harness.usage') {
        const usage = event.data as EventPayloads['harness.usage']; used.tokens += usage.inputTokens + usage.outputTokens; used.costUsd += usage.costUsd ?? 0
      }
      const ratio = budgetUsage(run.budget, used).ratio
      if (ratio >= (thresholds.budgetMedium ?? .8)) add('budget', ratio >= (thresholds.budgetHigh ?? 1) ? 'high' : 'medium', run.requirementId, run.runId, '运行预算预警', `用量达到 ${(ratio * 100).toFixed(1)}%`, run.runId)
    }
    // 不展开成参数：长运行的事件能有几十万条，Math.max(...events) 会爆栈
    let last = Date.parse(run.startedAt)
    for (const event of events) last = Math.max(last, Date.parse(event.ts))
    if (lastAt) last = Math.max(last, Date.parse(lastAt))
    if (run.status === 'running' && time - last > (thresholds.stalledMs ?? 15 * 60000)) add('stalled', 'high', run.requirementId, run.runId, '运行长时间无新事件', '请检查运行中的节点', run.runId)
    const relevant = new Map<string, EventEnvelope>()
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      const key = `${event.type}:${event.nodeId ?? ''}`
      if (['retry.suppressed', 'review.exhausted', 'gate.result'].includes(event.type)) relevant.set(key, event)
    }
    for (const event of relevant.values()) {
      if (run.status === 'cancelled' || run.status === 'succeeded' || event.nodeId && run.nodes[event.nodeId]?.status === 'succeeded') continue
      if (event.type === 'retry.suppressed') add('repeat-failure', 'high', run.requirementId, `${run.runId}/${event.nodeId ?? ''}`, '重复失败已停止重试', (event.data as EventPayloads['retry.suppressed']).reason, run.runId, event.nodeId)
      if (event.type === 'review.exhausted') add('review-stuck', 'medium', run.requirementId, `${run.runId}/${event.nodeId ?? ''}`, '评审未能继续推进', (event.data as EventPayloads['review.exhausted']).reason ?? '评审轮次已用完', run.runId, event.nodeId)
      if (event.type === 'gate.result' && !(event.data as EventPayloads['gate.result']).pass) add('gate-failed', 'high', run.requirementId, `${run.runId}/${event.nodeId ?? ''}`, '交付校验未通过', '请检查失败的门禁项', run.runId, event.nodeId)
    }
  }
  for (const req of snapshot.requirements) {
    if (!req.dueAt || ['delivered', 'archived'].includes(req.status)) continue
    const duration = Date.parse(req.dueAt) - Date.parse(req.createdAt), remaining = Date.parse(req.dueAt) - time
    if (remaining < duration * (thresholds.deadlineRatio ?? .25)) add('deadline', 'medium', req.id, req.id, '需求临近截止时间', `截止时间 ${req.dueAt}`)
  }
  for (const defect of snapshot.defects ?? []) add('defect-escape', 'medium', defect.requirementId, defect.id, '已确认逃逸缺陷', defect.title)
  for (const card of snapshot.scorecards ?? []) if (card.regression?.suspected) add('regression', 'medium', '', `${card.key.workflowId ?? ''}/${card.key.nodeId ?? card.label}`, '成绩单疑似退化', card.regression.reason ?? card.label)
  return risks
}
export async function computeRisks(stores: ProjectStores, spaceId: string, now: Date, thresholds?: RiskThresholds): Promise<ComputedRisk[]> {
  const requirements = await stores.workspaces.listRequirements(), runs = await stores.runs.list()
  // 风险只看用量、重复失败、评审卡住、门禁结果和最后一条事件的时间：按类型取缓存的子集，不再每次整份解析事件日志
  return computeRiskSnapshot({ requirements, runs: await Promise.all(runs.map(async (run) => {
    const [events, lastAt] = await Promise.all([runEventsOf(stores, run, RISK_EVENT_TYPES), runLastEventAt(stores, run)])
    return { run, events, lastAt }
  })),
    attention: await stores.attention.list({ pending: true }),
    defects: (await Promise.all(requirements.map((req) => listDefects(stores, req.id)))).flat().filter((d) => d.status === 'confirmed'),
    scorecards: await scorecards(stores, { by: 'node' }),
  }, spaceId, now, thresholds)
}
