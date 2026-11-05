import { expect, it } from 'vitest'
import type { AttentionItem } from '../interfaces.js'
import type { ArtifactRef, NodeState } from '../types.js'
import { checkAnswerFreshness, validateAnswer, AttentionAlreadyAnsweredError } from './attention-rules.js'
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

const node = (attempts: number): NodeState => ({ id: 'n', status: 'waiting_human', attempts, outputs: [] })
const ref = (path: string, version?: number): ArtifactRef => ({
  workspace: 'REQ-1', path, ...(version === undefined ? {} : { version }),
})

it('待办冻结内容检查：尝试次数和产物版本任一变化都不新鲜', () => {
  expect(checkAnswerFreshness(item, node(2), [])).toEqual({ ok: true })
  expect(checkAnswerFreshness({ ...item, attempt: 1 }, node(2), [])).toMatchObject({ ok: false })
  expect(checkAnswerFreshness({ ...item, attempt: 2 }, node(2), [])).toEqual({ ok: true })

  const frozen = { ...item, attempt: 2, subjects: [ref('spec.md', 3)] }
  expect(checkAnswerFreshness(frozen, node(2), [ref('spec.md', 3)])).toEqual({ ok: true })
  expect(checkAnswerFreshness(frozen, node(2), [ref('spec.md', 4)])).toMatchObject({ ok: false })
  expect(checkAnswerFreshness(frozen, node(2), [])).toMatchObject({ ok: false })
  expect(checkAnswerFreshness({ ...item, attempt: 2, subjects: [ref('spec.md')] }, node(2), [ref('spec.md', 1)])).toMatchObject({ ok: false })
  expect(checkAnswerFreshness({ ...item, attempt: 2, subjects: [ref('spec.md', 3), ref('plan.md', 1)] }, node(2), [ref('spec.md', 3), ref('plan.md', 2)])).toMatchObject({ ok: false })
})
