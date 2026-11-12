import type { AutomationAction, AutomationConfig, AutomationEvent, AutomationRunRecord, ChannelConfig } from '@taktflow/core'
import { describeCron, nextCron, parseCron } from '../../lib/cron'
import type { Tone } from '../../lib/status'

/** 自动化页的文案与模板（docs/design/30 §4）。 */

export const EVENTS: Record<AutomationEvent, { label: string; when: string }> = {
  'run.finished': { label: '运行成功结束', when: '运行成功结束时' },
  'run.failed': { label: '运行失败', when: '运行失败时' },
  'requirement.created': { label: '新建需求', when: '新建需求时' },
  'attention.overdue': { label: '等人超时', when: '等人决定超时时' },
}

export const ACTIONS: Record<AutomationAction['kind'], { label: string; hint: string }> = {
  digest: { label: '发进展汇报', hint: '各需求的最新进展、等人的事、失败的运行；同一需求只留最新一条，没变化不发' },
  notify: { label: '发消息', hint: '按模板发一句话，可以带需求、运行和链接' },
  start_workflow: { label: '启动流水线', hint: '对需求跑一条流水线；已有运行在跑时跳过' },
}

export const CHANNEL_KINDS: Record<ChannelConfig['kind'], { label: string; hint: string }> = {
  feishu: { label: '飞书', hint: '群机器人的 webhook 地址；开了签名校验的再填签名密钥' },
  slack: { label: 'Slack', hint: 'Incoming Webhook 地址' },
  webhook: { label: 'Webhook', hint: '任意 HTTP 地址，收到 JSON；填了签名密钥会带 X-Takt-Signature' },
}

/** notify 文本里能用的占位符。 */
export const PLACEHOLDERS: Array<{ token: string; label: string }> = [
  { token: '{{requirement.title}}', label: '需求标题' },
  { token: '{{run.id}}', label: '运行 id' },
  { token: '{{run.status}}', label: '运行状态' },
  { token: '{{node.id}}', label: '节点' },
  { token: '{{link}}', label: '链接' },
]

export const SCHEDULES: Array<{ cron: string; label: string }> = [
  { cron: '30 18 * * 1-5', label: '工作日 18:30' },
  { cron: '30 9 * * 1-5', label: '工作日 09:30' },
  { cron: '0 9 * * *', label: '每天 09:00' },
  { cron: '0 10 * * 1', label: '每周一 10:00' },
  { cron: '0 * * * *', label: '每小时整点' },
]

export const RUN_STATUS: Record<AutomationRunRecord['status'], { label: string; tone: Tone }> = {
  running: { label: '执行中', tone: 'running' },
  ok: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'failed' },
  skipped: { label: '跳过', tone: 'stale' },
}

export const TRIGGER_KIND: Record<AutomationRunRecord['trigger'], string> = { schedule: '定时', event: '事件', manual: '手动', retry: '重试' }

export function triggerText(a: Pick<AutomationConfig, 'trigger'>): string {
  if ('schedule' in a.trigger) return describeCron(a.trigger.schedule) ?? `cron ${a.trigger.schedule}`
  const f = a.trigger.filter
  const scope = [f?.workflowIds?.length ? `流水线 ${f.workflowIds.join('、')}` : '', f?.requirementIds?.length ? f.requirementIds.join('、') : ''].filter(Boolean).join(' · ')
  return `${EVENTS[a.trigger.event].when}${scope ? `（${scope}）` : ''}`
}

export function actionText(a: Pick<AutomationConfig, 'action'>): string {
  const x = a.action
  if (x.kind === 'start_workflow') return `启动 ${x.workflowId}${x.requirementId ? `（${x.requirementId}）` : '（事件里的需求）'}`
  if (x.kind === 'digest') return x.sinceHours ? `发最近 ${x.sinceHours} 小时的进展汇报` : '发进展汇报'
  return '发消息'
}

export interface Template {
  id: string
  title: string
  body: string
  make: () => AutomationConfig
}

/** 空态与"新建"菜单里的 4 个模板（docs/design/30 §4）。渠道由编辑器补上。 */
export const TEMPLATES: Template[] = [
  {
    id: 'daily-digest',
    title: '每日进展',
    body: '工作日 18:30 把各需求的最新进展、等人的事、失败的运行发到群里',
    make: () => ({ id: 'daily-digest', title: '每日进展', enabled: true, trigger: { schedule: '30 18 * * 1-5' }, action: { kind: 'digest' }, notify: { channels: [] } }),
  },
  {
    id: 'run-failed',
    title: '运行失败告警',
    body: '运行失败时马上发一条，带需求和运行链接',
    make: () => ({ id: 'run-failed', title: '运行失败告警', enabled: true, trigger: { event: 'run.failed' }, action: { kind: 'notify', text: '{{requirement.title}} 的运行 {{run.id}} 失败了：{{link}}' }, notify: { channels: [] } }),
  },
  {
    id: 'overdue',
    title: '等人超时提醒',
    body: '待办等人决定超过时限时提醒（同一个待办只提醒一次）',
    make: () => ({ id: 'overdue', title: '等人超时提醒', enabled: true, trigger: { event: 'attention.overdue' }, action: { kind: 'notify', text: '{{requirement.title}} 在等人决定（节点 {{node.id}}），已超时：{{link}}' }, notify: { channels: [] } }),
  },
  {
    id: 'auto-start',
    title: '新需求自动启动',
    body: '新建需求后自动跑一条流水线，不用再手动点启动',
    make: () => ({ id: 'auto-start', title: '新需求自动启动', enabled: true, trigger: { event: 'requirement.created' }, action: { kind: 'start_workflow', workflowId: '' } }),
  },
]

export const blankAutomation = (): AutomationConfig => ({ id: '', title: '', enabled: true, trigger: { schedule: '30 18 * * 1-5' }, action: { kind: 'digest' }, notify: { channels: [] } })

/**
 * 自定义 cron 的问题：写法不对时指出第几段；写法对但 8 年内一次都不会触发（如 2 月 31 日）时也算错，不让保存。
 * 没问题时返回下一次触发时间。
 */
export function cronCheck(expr: string, after = new Date()): { error: string } | { next: Date } {
  try {
    const next = nextCron(parseCron(expr), after)
    return next ? { next } : { error: '这个时间表永远不会触发（比如 2 月 31 日、4 月 31 日），换一个日期或改成按周' }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export const AUTOMATION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** 新建时给一个不重名的 id（模板 id 或 automation-n）。 */
export function freeId(base: string, taken: string[]): string {
  const b = AUTOMATION_ID.test(base) ? base : 'automation'
  if (!taken.includes(b)) return b
  for (let i = 2; ; i++) if (!taken.includes(`${b}-${i}`)) return `${b}-${i}`
}
