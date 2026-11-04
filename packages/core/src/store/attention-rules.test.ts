import { expect, it } from 'vitest'
import type { AttentionItem } from '../interfaces.js'
import { validateAnswer, AttentionAlreadyAnsweredError } from './attention-rules.js'
const item: AttentionItem = { requestId: 'q', runId: 'r', nodeId: 'n', requirementId: 'REQ-1', ask: '?', form: 'approve', createdAt: '' }
it('共用表单规则拒绝未知决定和不匹配回答', () => {
  expect(() => validateAnswer(item, { decision: 'approve' })).not.toThrow()
  expect(() => validateAnswer(item, { decision: 'reject' })).not.toThrow()
  expect(() => validateAnswer(item, { answer: 'text' })).toThrow('不接受')
  expect(() => validateAnswer({ ...item, form: 'answer' }, { decision: 'unknown', answer: 'text' })).toThrow('不支持')
  expect(() => validateAnswer({ ...item, form: 'answer' }, { answer: ' ' })).toThrow('不能为空')
  expect(() => validateAnswer({ ...item, form: 'choice', choices: ['A'] }, { decision: 'choice', answer: 'B' })).toThrow('必须')
  expect(() => validateAnswer({ ...item, form: 'choice', choices: ['A'] }, { decision: 'choice', answer: 'A' })).not.toThrow()
  expect(() => validateAnswer({ ...item, answeredAt: 'now' }, { decision: 'approve' })).toThrow(AttentionAlreadyAnsweredError)
})
