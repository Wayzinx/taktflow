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
    return { id, criterion, pass: check?.pass === true && check.criterion === criterion && !!evidence?.trim(), evidence }
  })
  return { checks, unmet: checks.filter((check) => !check.pass).map((check) => check.id) }
}

export function resultSummary(data: unknown, finalText: string): string {
  const summary = data && typeof data === 'object' && 'summary' in data && typeof data.summary === 'string' ? data.summary : finalText.split(/\r?\n/)[0] ?? ''
  return [...summary].slice(0, 80).join('')
}
