import { describe, expect, it } from 'vitest'
import { answerOutcome } from './attention-outcome'

const item = { nodeId: 'implement', runId: 'run-1', kind: 'retry' as const }

describe('answerOutcome', () => {
  it('终止 / 停止类选项说明将停止，不说"运行将自动继续"', () => {
    for (const [kind, answer] of [['retry', '终止运行'], ['budget', '停止运行']] as const) {
      const r = answerOutcome({ ...item, kind }, { decision: 'choice', answer })
      expect(r).toMatchObject({ tone: 'skipped', stopped: true })
      expect(r.body).toContain('终止运行 run-1')
      expect(r.body).not.toContain('自动继续')
    }
    expect(answerOutcome(item, { decision: 'cancelled' }).stopped).toBe(true)
    expect(answerOutcome({ ...item, kind: 'node', choices: ['放行', '打回', '终止'] }, { decision: 'choice', answer: '终止' })).toMatchObject({ stopped: true, body: expect.stringContaining('记为失败') })
  })
  it('重试 / 交给人 / 打回各说各的结果', () => {
    expect(answerOutcome(item, { decision: 'choice', answer: '再试一次' }).body).toBe('implement 会重新执行，运行将自动继续。')
    expect(answerOutcome(item, { decision: 'choice', answer: '交给人处理' })).toMatchObject({ tone: 'waiting', body: expect.stringContaining('不会自动重跑') })
    expect(answerOutcome(item, { decision: 'reject' }).body).not.toContain('自动继续')
  })
  it('普通节点不冒充引擎终止运行，取消只说明节点', () => {
    expect(answerOutcome({ ...item, kind: 'node' }, { decision: 'choice', answer: '终止运行' }).stopped).toBeUndefined()
    expect(answerOutcome({ ...item, kind: 'node', choices: ['终止', '继续'] }, { decision: 'choice', answer: '终止' }).stopped).toBeUndefined()
    expect(answerOutcome({ ...item, kind: 'node' }, { decision: 'cancelled' }).body).toContain('取消节点 implement')
    expect(answerOutcome({ ...item, kind: 'budget' }, { decision: 'choice', answer: '停止运行' }).stopped).toBe(true)
  })
  it('其余回答照旧', () => {
    expect(answerOutcome(item, { decision: 'approve' })).toEqual({ body: '已提交，运行将自动继续。', tone: 'success' })
    expect(answerOutcome(item, { decision: 'choice', answer: '追加 50% 预算' }).tone).toBe('success')
    expect(answerOutcome(item, { answer: '用方案 B' }).body).toBe('已提交，运行将自动继续。')
  })
})
