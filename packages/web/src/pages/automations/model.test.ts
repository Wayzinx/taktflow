import { describe, expect, it } from 'vitest'
import { ACTIONS, CHANNEL_KINDS, EVENTS, TEMPLATES, cronCheck, triggerText } from './model'

describe('自定义 cron（TF-088）', () => {
  const after = new Date('2026-11-12T10:00:00')
  it('写法对但永远不会触发：算错，不让保存', () => {
    expect(cronCheck('0 9 31 2 *', after)).toEqual({ error: expect.stringContaining('永远不会触发') })
    expect(cronCheck('0 9 31 4 *', after)).toEqual({ error: expect.stringContaining('永远不会触发') })
  })
  it('闰年的 2 月 29 日能触发', () => {
    const r = cronCheck('0 9 29 2 *', after)
    expect('next' in r && r.next.getFullYear()).toBe(2028)
  })
  it('写法不对：沿用逐段的报错', () => {
    expect(cronCheck('61 25 * * *', after)).toEqual({ error: expect.stringContaining('第 1 段') })
    expect(cronCheck('* * *', after)).toEqual({ error: '要 5 段：分 时 日 月 周' })
  })
})

describe('文案统一用中文术语（TF-074）', () => {
  it('动作、事件、模板、触发说明里不出现 workflow / duties / draft', () => {
    const texts = [
      ...Object.values(ACTIONS).flatMap((a) => [a.label, a.hint]),
      ...Object.values(EVENTS).flatMap((e) => [e.label, e.when]),
      ...Object.values(CHANNEL_KINDS).flatMap((c) => [c.label, c.hint]),
      ...TEMPLATES.flatMap((t) => [t.title, t.body]),
      triggerText({ trigger: { event: 'run.failed', filter: { workflowIds: ['standard'] } } }),
    ]
    for (const t of texts) expect(t).not.toMatch(/\bworkflow\b|duties|draft/i)
  })
})
