import type { JudgeVerdict, VerdictCategory } from '../types.js'

/** 写进群聊、待办的话要给人看：长文本截断，原始 JSON 换成要点。完整内容仍在事件和产物里。 */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

const parse = (text: string): unknown => {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined
  try { return JSON.parse(t) } catch { return undefined }
}

/** 报错一句话：harness 把整段结果 JSON 当错误抛出时，取 result / message / subtype。 */
export function briefError(text: string, max = 200): string {
  const value = parse(text) as Record<string, unknown> | undefined
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const error = value.error as { message?: unknown } | string | undefined
    const said = [value.result, value.message, typeof error === 'string' ? error : error?.message].find((v) => typeof v === 'string' && v.trim()) as string | undefined
    const kind = typeof value.subtype === 'string' && value.subtype !== 'success' ? value.subtype : undefined
    const line = [kind, said?.replace(/\s+/g, ' ').trim()].filter(Boolean).join('：')
    if (line) return clip(line, max)
  }
  return clip(text.replace(/\s+/g, ' ').trim(), max)
}

/** 打回重做带的评审意见：{ round, records: [{ reviewer, issues: [{ severity }] }] } 换成"第几轮、几位评审、几个问题"。 */
export function briefReviewFeedback(feedback: string): string {
  const value = parse(feedback) as { round?: unknown; records?: Array<{ reviewer?: unknown; issues?: Array<{ severity?: unknown }> }> } | undefined
  if (!value || !Array.isArray(value.records)) return clip(feedback.replace(/\s+/g, ' ').trim(), 200)
  const issues = value.records.flatMap((r) => (Array.isArray(r.issues) ? r.issues : []))
  const bySeverity = new Map<string, number>()
  for (const issue of issues) {
    const severity = typeof issue.severity === 'string' ? issue.severity : '未分级'
    bySeverity.set(severity, (bySeverity.get(severity) ?? 0) + 1)
  }
  const counts = [...bySeverity].map(([severity, n]) => `${severity} ${n}`).join('、')
  const round = typeof value.round === 'number' ? `第 ${value.round} 轮评审` : '评审'
  return `${round}：${value.records.length} 位评审提了 ${issues.length} 个问题${counts ? `（${counts}）` : ''}。`
}

const VERDICT_LABEL: Record<VerdictCategory, string> = {
  product_bug: '代码缺陷', case_defect: '用例缺陷', script_defect: '脚本缺陷', env_issue: '环境问题', flaky: '不稳定',
  requirement_gap: '需求缺口', test_data: '测试数据', deployment: '部署问题', permission: '权限问题', external_dependency: '外部依赖', unknown: '无法判定',
}

/** 判决交人时的提问：每条一行（对象 · 类别：理由），最多 6 条，结尾说清通过 / 打回的后果。 */
export function judgeAsk(title: string, verdicts: JudgeVerdict[]): string {
  const shown = verdicts.slice(0, 6).map((v) => `· ${v.subject} · ${VERDICT_LABEL[v.category] ?? v.category}：${clip(v.rationale.replace(/\s+/g, ' ').trim(), 160)}`)
  const more = verdicts.length > shown.length ? [`…等 ${verdicts.length} 条，完整判决见判决产物`] : []
  return [
    `${title}有 ${verdicts.length} 条判决需要你裁决：`,
    ...shown,
    ...more,
    '通过：按这些判决放行，继续后面的节点。打回：这一步记为失败，运行结束，之后可以在运行页重试。',
  ].join('\n')
}
