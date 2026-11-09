import { join } from 'node:path'
import { buildDigest, StewardStore, type AutomationConfig, type AutomationRunRecord, type ProjectStores, type StewardDeps } from '@taktflow/core'
import { commandExecutor, type M3Callbacks } from './m3-routes.js'
import { spaceId, spaceSummary, workflowStore } from './space.js'
import type { ChannelMessage } from './channel-delivery.js'

export interface AutomationActionOptions extends M3Callbacks { publicUrl: string; multiSpace?: boolean }
export const automationActor = (id: string) => ({ type: 'agent' as const, role: `automation:${id}`, harness: 'automation' })
export function automationLinks(stores: ProjectStores, options: AutomationActionOptions) {
  const root = (process.env.TAKT_PUBLIC_URL || options.publicUrl).replace(/\/$/, '') + (options.multiSpace ? `/s/${encodeURIComponent(spaceId(stores))}` : '')
  return { requirement: (id: string) => `${root}/req/${encodeURIComponent(id)}`, run: (id: string) => `${root}/run/${encodeURIComponent(id)}` }
}
export async function automationAction(stores: ProjectStores, automation: AutomationConfig, record: AutomationRunRecord, options: AutomationActionOptions, lastSuccess?: string): Promise<ChannelMessage | undefined> {
  const action = automation.action, links = automationLinks(stores, options), event = record.event
  const message: ChannelMessage = { automation: { id: automation.id, title: automation.title }, event, text: '', links: [] }
  const skip = (summary: string) => { record.status = 'skipped'; record.summary = summary; return undefined }
  if (action.kind === 'start_workflow') {
    const requirementId = action.requirementId ?? event?.requirementId
    if (!requirementId || !await stores.workspaces.getRequirement(requirementId)) return skip('需求不存在，请选择已有需求后重试')
    const runs = await stores.runs.list({ requirementId })
    if (runs.some(r => ['running', 'waiting_human', 'paused'].includes(r.status))) return skip('需求已有运行在跑，请结束当前运行后重试')
    const result = await (await commandExecutor(options).commands(stores, 'run.start')).run('run.start', {
      workflowId: action.workflowId, requirementId, args: { __taktAutomation: automation.id },
    }, { actor: automationActor(automation.id), reason: `自动化：${automation.title}` })
    if (!result.ok) { if (/已有运行|不存在/.test(result.message)) return skip(result.message); throw new Error(result.message) }
    const started = result.result as { runId?: string; run?: { runId?: string }; refs?: { runId?: string } } | undefined
    record.runId = started?.runId ?? started?.run?.runId ?? started?.refs?.runId
    if (!record.runId) throw new Error('run.start 未返回 runId，请检查命令处理器')
    record.summary = `已启动 ${record.runId}`; message.text = record.summary; message.links = [links.run(record.runId)]
  } else if (action.kind === 'notify') {
    const req = event?.requirementId ? await stores.workspaces.getRequirement(event.requirementId) : undefined
    const run = event?.runId ? await stores.runs.get(event.runId) : undefined
    const link = event?.runId ? links.run(event.runId) : event?.requirementId ? links.requirement(event.requirementId) : ''
    const values: Record<string, string> = { 'requirement.title': req?.title ?? '', 'run.id': event?.runId ?? '', 'run.status': run?.status ?? '', 'node.id': event?.nodeId ?? '', link }
    message.text = action.text.replace(/{{\s*([^{}]+?)\s*}}/g, (_, key: string) => values[key] ?? '')
    message.links = link ? [link] : []; record.summary = '已发送通知'
  } else {
    const since = action.sinceHours ? new Date(Date.now() - action.sinceHours * 3600_000).toISOString() : lastSuccess ?? new Date(Date.now() - 86400_000).toISOString()
    const dataDir = join(stores.taktDir, 'automations/digest')
    const deps: StewardDeps = { dataDir: () => dataDir, spaces: async () => [await spaceSummary(stores)], open: async () => ({
      id: spaceId(stores), name: stores.config.project.name, dir: stores.projectDir, stores,
      commands: await commandExecutor(options).commands(stores), workflows: workflowStore(stores),
      postToLead: async () => { throw new Error('自动化汇报不发送群聊消息') }, onChat: () => () => {},
    }) }
    const digest = await buildDigest(deps, new StewardStore(dataDir), since, false, true)
    const failures = (await stores.runs.list()).filter(r => r.status === 'failed' && (r.endedAt ?? r.startedAt) > since)
    if (!digest.progress.length && !failures.length && !digest.attention.some(a => a.since > since)) return skip('没有任何变化，本次不发送汇报')
    const requirements = await stores.workspaces.listRequirements(), labels = { created: '新建需求', started: '开始运行', stage: '进入阶段', delivered: '已交付', blocked: '受阻', failed: '运行失败' }
    const lines = digest.progress.map(p => {
      message.links.push(links.requirement(p.requirementId))
      return `${p.title}｜${labels[p.kind]}${p.to ? `：${p.to}` : ''}｜${requirements.find(r => r.id === p.requirementId)?.status ?? ''} ${links.requirement(p.requirementId)}`
    })
    message.links.push(...digest.attention.map(a => links.requirement(a.requirementId)), ...failures.map(r => links.run(r.runId)))
    message.links = [...new Set(message.links)]
    if (digest.attention.length) lines.push('等人的事：', ...digest.attention.map(a => `${a.requirementTitle}：${a.ask} ${links.requirement(a.requirementId)}`))
    if (failures.length) lines.push('失败的运行：', ...failures.map(r => `${r.runId} ${links.run(r.runId)}`))
    message.text = lines.join('\n'); record.summary = `已推送 ${digest.progress.length} 个需求的进展`
  }
  record.text = message.text
  return message
}
