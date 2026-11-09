import type { CompletionCheck } from '../types.js'

export function completionPrompt(criteria: string[] = []): string {
  if (!criteria.length) return ''
  return `完成标准（逐条自检）\n${criteria.map((criterion, index) => `c${index + 1}: ${criterion}`).join('\n')}\n结果 JSON 必须包含 checks，每条恰好一项：{ id, criterion, pass, evidence }；通过时必须提供可核查的证据。`
}

export function completionSchema(schema: Record<string, unknown> | undefined, criteria: string[] = []): Record<string, unknown> | undefined {
  if (!criteria.length) return schema
  return { ...schema, type: 'object', required: [...new Set([...(schema?.required as string[] | undefined ?? []), 'checks'])],
    properties: { ...schema?.properties as object, checks: { type: 'array', items: {
      type: 'object', required: ['id', 'criterion', 'pass'], properties: {
        id: { type: 'string', enum: criteria.map((_, index) => `c${index + 1}`) }, criterion: { type: 'string' },
        pass: { type: 'boolean' }, evidence: { type: 'string' },
      },
    } } } }
}

export function checkCompletion(criteria: string[], data: unknown): { checks: CompletionCheck[]; unmet: string[] } {
  const raw = data && typeof data === 'object' && 'checks' in data && Array.isArray(data.checks) ? data.checks : []
  const checks = criteria.map((criterion, index): CompletionCheck => {
    const id = `c${index + 1}`
    const matches = raw.filter((check) => check && typeof check === 'object' && check.id === id)
    const check = matches.length === 1 ? matches[0] as Record<string, unknown> : undefined
    const evidence = typeof check?.evidence === 'string' ? check.evidence : undefined
    return { id, criterion, pass: check?.pass === true && !!evidence?.trim(), evidence }
  })
  return { checks, unmet: checks.filter((check) => !check.pass).map((check) => check.id) }
}

export function resultSummary(data: unknown, finalText: string): string {
  const record = data && typeof data === 'object' ? data as { summary?: unknown; items?: unknown } : {}
  let summary = typeof record.summary === 'string' ? record.summary : finalText.split(/\r?\n/)[0] ?? ''
  // 原生结构约束时最终回复本身就是 JSON：规划写成条目，其余不把原始 JSON 当小结
  if (typeof record.summary !== 'string' && Array.isArray(record.items)) {
    const titles = record.items.map(item => item && typeof item === 'object' && typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '').filter(Boolean)
    summary = `规划 ${record.items.length} 个条目${titles.length ? `：${titles.join('、')}` : ''}`
  } else if (typeof record.summary !== 'string' && /^\s*[[{]/.test(summary)) summary = ''
  return [...summary].slice(0, 80).join('')
}

export function completionErrors(criteria: string[], data: unknown): string[] {
  if (!criteria.length) return []
  const checks = (data as { checks: Array<{ id: string; pass: boolean; evidence?: string }> }).checks
  const errors: string[] = []
  for (const [index] of criteria.entries()) {
    const id = `c${index + 1}`
    const matches = checks.filter(check => check.id === id)
    if (matches.length !== 1) errors.push(`$.checks：检查项 ${id} 必须恰好出现一次（实际 ${matches.length} 次）`)
  }
  return errors
}
