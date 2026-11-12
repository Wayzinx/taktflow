import type { Tier, WorkflowSummary } from '@taktflow/core'

/**
 * 草稿路由的本地兜底规则：正常走服务端 POST /route/preview（与创建时同一个路由器），
 * 接口不可用时才用这里，只看改动形状的线索。
 */
export interface RouteEstimate {
  tier: Tier
  workflowId?: string
  workflowTitle?: string
  reason: string
  /** server：服务端路由器（与创建时同一个）给的；local：接口不可用时本地关键词规则给的。 */
  source: 'server' | 'local'
}

const SMALL = /文案|拼写|错别字|typo|文件名|颜色|样式微调|格式|改个|小改|hotfix|修复|bug|崩溃|报错/i
const SURFACES: Array<[RegExp, string]> = [
  [/前端|页面|按钮|弹窗|交互|UI|样式/i, '前端'],
  [/接口|API|服务端|后端|网关/i, '接口'],
  [/数据库|表结构|迁移|索引|SQL/i, '数据'],
  [/定时|任务|消息|通知|推送|队列/i, '异步任务'],
  [/CLI|命令行|脚本/i, '命令行'],
  [/客户端|iOS|Android|小程序/i, '客户端'],
]
const PARALLEL = /互不|独立|并行|各自|分别/
const PATH = /(?:^|[\s`"'(（，、])((?:[\w.-]+\/)+[\w.*?/-]*)/g

export function estimateRoute(text: string, workflows: WorkflowSummary[] | undefined): RouteEstimate | undefined {
  const t = text.trim()
  if (t.length < 4) return undefined
  const hits = SURFACES.filter(([re]) => re.test(t)).map(([, name]) => name)
  const roots = new Set([...t.matchAll(PATH)].map((match) => match[1]!.replace(/^\.\//, '').split('/')[0]!).filter(Boolean))
  let tier: Tier
  let reason: string
  if (SMALL.test(t) && hits.length <= 1) {
    tier = 'T1'
    reason = hits.length ? `看起来只动${hits[0]}一处，单一改动面，走快速修复。` : '描述像一处小改动，单一改动面，走快速修复。'
  } else if (roots.size >= 2 && hits.length === 0 && PARALLEL.test(t)) {
    tier = 'T3'
    reason = '几处路径改动互不依赖且路径不相交，可以并行研发。'
  } else if (hits.length >= 2) {
    tier = 'T2'
    reason = `涉及${hits.join('、')}，有先后依赖，按标准流水线串行推进。`
  } else {
    tier = 'T2'
    reason = hits.length ? `主要改${hits[0]}，范围还不清楚，先按标准流水线走，评审时再收窄。` : '范围还不清楚，先按标准流水线走，评审时再收窄。'
  }
  const want = tier === 'T1' ? ['quick-fix', 'hotfix', 'quick'] : ['sdlc', 'standard']
  const wf = workflows?.find((w) => want.includes(w.id)) ?? workflows?.find((w) => want.some((x) => w.id.includes(x)))
  return { tier, workflowId: wf?.id, workflowTitle: wf?.title, reason, source: 'local' }
}

/**
 * 路由预览 409（空间没有流水线 / 没有接得住该档位的流水线）是配置问题，原因要原样给用户看；
 * 其他错误（旧服务端、离线）才退回本地规则。
 */
export function routePreviewFailure(e: unknown): string | undefined {
  const status = (e as { status?: number } | undefined)?.status
  return status === 409 && e instanceof Error && e.message ? e.message : undefined
}

/**
 * 规则模板：未配置管家模型时的验收标准清单（界面上明确标成"规则模板"，不冒充管家）。
 * 只给通用、可验证的条目，不编造描述里没有的具体数字。配置了模型时走真实管家（ac-assist.tsx）。
 */
export function suggestAcceptance(text: string, title: string): string[] {
  const t = `${title}\n${text}`
  const out: string[] = []
  const subject = title.replace(/^(支持|新增|增加|优化|修复)/, '').trim() || '该功能'
  out.push(`正常路径：用户完成「${subject}」的主要操作后，结果立即可见且刷新后保持`)
  if (/批量|多选|全部/.test(t)) out.push('批量操作：部分失败时逐项提示原因，成功项不回滚')
  if (/删除|移除|清空/.test(t)) out.push('删除前二次确认，删除后可以撤销')
  if (/导出|下载|CSV|Excel/i.test(t)) out.push('导出的字段与列表一致，文件名含日期；数据量大时不阻塞页面')
  if (/登录|验证码|权限|鉴权/.test(t)) out.push('未登录或无权限时返回明确错误码，前端给出可操作的提示')
  if (/接口|API/i.test(t)) out.push('接口对非法参数返回 400 与字段级错误信息，不出现 500')
  if (/页面|按钮|前端|UI/i.test(t)) out.push('加载、空、错误三种状态都有对应界面，窄屏下布局不错乱')
  if (/通知|消息|提醒|推送/.test(t)) out.push('同一事件只通知一次，用户可在设置中关闭')
  out.push('异常路径：网络失败或超时后可重试，不产生重复数据')
  out.push('有对应的自动化用例覆盖正常与异常路径，并接入 CI')
  return out.slice(0, 6)
}

/** 把一条验收标准插到文本的"验收标准"段末尾；没有这一段就在最后新建。 */
export function insertAcceptance(text: string, item: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  const head = lines.findIndex((l) => /^\s*(#+\s*)?验收标准\s*[:：]?\s*$/.test(l))
  if (head < 0) return `${lines.join('\n')}${lines.join('').trim() ? '\n\n' : ''}验收标准：\n- ${item}\n`
  let end = head + 1
  while (end < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[end]!)) end++
  lines.splice(end, 0, `- ${item}`)
  return `${lines.join('\n')}\n`
}

/** 从管家回复里取验收标准条目：以 - / * / 1. 开头的行，去掉 [n] 引用标记。 */
export function parseAcceptance(reply: string): string[] {
  return reply
    .split('\n')
    .map((l) => /^\s*(?:[-*•]|\d+[.)、])\s+(.+)$/.exec(l)?.[1]?.replace(/\s*\[\d+\]/g, '').replace(/\*\*/g, '').trim())
    .filter((x): x is string => !!x && x.length > 3)
    .slice(0, 8)
}
