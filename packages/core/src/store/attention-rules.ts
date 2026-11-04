import type { AttentionItem } from '../interfaces.js'

export class AttentionAlreadyAnsweredError extends Error {
  constructor(requestId: string) {
    super(`待办已处理：${requestId}`)
    this.name = 'AttentionAlreadyAnsweredError'
  }
}

export function validateAnswer(item: AttentionItem, input: { decision?: string; answer?: string }): void {
  if (item.answeredAt !== undefined) throw new AttentionAlreadyAnsweredError(item.requestId)
  if (input.decision === 'choice') {
    if (item.form !== 'choice') throw new Error(`待办表单 ${item.form} 不接受选项回答`)
    if (!item.choices?.includes(input.answer ?? '')) throw new Error(`回答必须是以下选项之一：${(item.choices ?? []).join(', ')}`)
    return
  }
  if (input.decision === 'approve' || input.decision === 'reject') {
    if (item.form !== 'approve') throw new Error(`待办表单 ${item.form} 不接受审批决定`)
    return
  }
  if (input.decision !== undefined) throw new Error(`不支持的回答决定：${input.decision}`)
  if (item.form !== 'answer') throw new Error(`待办表单 ${item.form} 不接受文本回答`)
  if (!input.answer?.trim()) throw new Error('回答不能为空')
}
