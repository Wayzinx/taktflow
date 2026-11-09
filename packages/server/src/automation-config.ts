import { assertSecretName, AutomationRecords, nextCronAt, parseCron, secretStatus, loadPlugins,
  type AutomationConfig, type AutomationsView, type ChannelConfig, type ChannelView, type ProjectStores, type TaktConfig } from '@taktflow/core'
import { HttpError } from './http.js'
import { workflowStore } from './space.js'

export function automationId(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new HttpError(400, 'id 不合法，请使用小写字母、数字或短横线，最多 40 位')
  return id
}
const invalid = (field: string, message: string): never => { throw new HttpError(400, `${field}：${message}，请修正配置后重试`) }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, '必须是对象')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], field: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${field}.${key}`, '不支持此字段')
}
function string(value: unknown, field: string): asserts value is string { if (typeof value !== 'string' || !value.trim()) invalid(field, '必须是非空字符串') }
function strings(value: unknown, field: string) { if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) invalid(field, '必须是字符串数组') }
export function readChannel(value: unknown, id: string): ChannelConfig {
  const c = object(value, 'channel')
  keys(c, ['id', 'title', 'kind', 'urlEnv', 'secretEnv'], 'channel')
  if (c.id !== automationId(id)) invalid('channel.id', '必须与路径一致')
  if (!['feishu', 'slack', 'webhook'].includes(String(c.kind))) invalid('channel.kind', '只支持 feishu、slack、webhook')
  if (c.title !== undefined) string(c.title, 'channel.title')
  for (const field of ['urlEnv', 'secretEnv']) if (field === 'urlEnv' || c[field] !== undefined) {
    string(c[field], `channel.${field}`)
    try { assertSecretName(c[field] as string) } catch { invalid(`channel.${field}`, '只能填写大写环境变量名，不能填写地址或密钥值') }
  }
  return c as unknown as ChannelConfig
}
export function readAutomation(value: unknown, id: string): AutomationConfig {
  const a = object(value, 'automation')
  keys(a, ['id', 'title', 'enabled', 'trigger', 'action', 'notify'], 'automation')
  if (a.id !== automationId(id)) invalid('automation.id', '必须与路径一致')
  string(a.title, 'title')
  if (typeof a.enabled !== 'boolean') invalid('enabled', '必须是 boolean')
  const trigger = object(a.trigger, 'trigger')
  if ('schedule' in trigger) {
    keys(trigger, ['schedule'], 'trigger'); string(trigger.schedule, 'trigger.schedule')
    try { parseCron(trigger.schedule) } catch (error) { invalid('trigger.schedule', (error as Error).message) }
  } else {
    keys(trigger, ['event', 'filter'], 'trigger')
    if (!['run.finished', 'run.failed', 'requirement.created', 'attention.overdue'].includes(String(trigger.event))) invalid('trigger.event', '事件不存在')
    if (trigger.filter !== undefined) {
      const filter = object(trigger.filter, 'trigger.filter'); keys(filter, ['workflowIds', 'requirementIds'], 'trigger.filter')
      for (const field of Object.keys(filter)) strings(filter[field], `trigger.filter.${field}`)
    }
  }
  const action = object(a.action, 'action')
  if (action.kind === 'start_workflow') {
    keys(action, ['kind', 'workflowId', 'requirementId'], 'action'); string(action.workflowId, 'action.workflowId')
    if ('schedule' in trigger || action.requirementId !== undefined) string(action.requirementId, 'action.requirementId')
  } else if (action.kind === 'digest') {
    keys(action, ['kind', 'sinceHours'], 'action')
    if (action.sinceHours !== undefined && (typeof action.sinceHours !== 'number' || !Number.isFinite(action.sinceHours) || action.sinceHours <= 0)) invalid('action.sinceHours', '必须是正数')
  } else if (action.kind === 'notify') { keys(action, ['kind', 'text'], 'action'); string(action.text, 'action.text') }
  else invalid('action.kind', '动作不存在')
  if (a.notify !== undefined) { const notify = object(a.notify, 'notify'); keys(notify, ['channels'], 'notify'); strings(notify.channels, 'notify.channels') }
  if (action.kind !== 'start_workflow' && !(a.notify as { channels?: string[] } | undefined)?.channels?.length) invalid('notify.channels', '至少选择一个渠道')
  return a as unknown as AutomationConfig
}
export async function workflowIds(stores: ProjectStores): Promise<string[]> {
  return [...(await workflowStore(stores).list({ record: false })).map(w => w.id), ...(await loadPlugins(stores.config, stores.projectDir, url => import(url))).workflows.map(w => w.id)]
}
export function referenceProblems(a: AutomationConfig, config: TaktConfig, workflows: string[]): string[] {
  const problems: string[] = []
  if (a.action.kind === 'start_workflow' && !workflows.includes(a.action.workflowId)) problems.push(`action.workflowId：workflow ${a.action.workflowId} 不存在，请重新选择`)
  for (const id of a.notify?.channels ?? []) if (!config.channels?.some(c => c.id === id)) problems.push(`notify.channels：渠道 ${id} 不存在，请重新选择`)
  return problems
}
export async function automationProblems(a: AutomationConfig, stores: ProjectStores, workflows?: string[]): Promise<string[]> {
  try { readAutomation(a, a.id) } catch (error) { return [(error as Error).message] }
  const problems = referenceProblems(a, stores.config, workflows ?? await workflowIds(stores))
  if (a.action.kind === 'start_workflow' && a.action.requirementId && !await stores.workspaces.getRequirement(a.action.requirementId)) problems.push(`action.requirementId：需求 ${a.action.requirementId} 不存在，请重新选择`)
  for (const id of a.notify?.channels ?? []) {
    const channel = stores.config.channels?.find(c => c.id === id)
    if (!channel) continue
    if (secretStatus(channel.urlEnv).source === 'missing') problems.push(`渠道 ${id} 地址缺失，请设置 ${channel.urlEnv}`)
    if (channel.secretEnv && secretStatus(channel.secretEnv).source === 'missing') problems.push(`渠道 ${id} 签名密钥缺失，请设置 ${channel.secretEnv}`)
  }
  return problems
}
export function channelView(c: ChannelConfig, config: TaktConfig): ChannelView {
  return { ...c, url: secretStatus(c.urlEnv).source, ...(c.secretEnv ? { secret: secretStatus(c.secretEnv).source } : {}), usedBy: (config.automations ?? []).filter(a => a.notify?.channels.includes(c.id)).map(a => a.id) }
}
export async function automationsView(stores: ProjectStores): Promise<AutomationsView> {
  const records = await new AutomationRecords(stores).list(), workflows = await workflowIds(stores)
  return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, channels: (stores.config.channels ?? []).map(c => channelView(c, stores.config)),
    automations: await Promise.all((stores.config.automations ?? []).map(async a => {
      const problems = await automationProblems(a, stores, workflows)
      let nextAt: string | undefined
      if (a.enabled && 'schedule' in a.trigger) { try { nextAt = nextCronAt(a.trigger.schedule) } catch { /* problems 包含 cron 错误。 */ } }
      return { ...a, nextAt, problems, lastRun: records.find(r => r.automationId === a.id) }
    })) }
}
