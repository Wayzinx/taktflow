import { expect, it } from 'vitest'
import { COST_UNREPORTED, costOf, fmtCost, fmtDateTime, fmtShare, summaryLine, tidyText } from './format'

it('summaryLine 把多行并成一行并截断，短文本原样返回', () => {
  expect(summaryLine('交付校验未通过：\n· acceptance：2 条 AC 未通过\n通过：放行')).toBe('交付校验未通过： · acceptance：2 条 AC 未通过 通过：放行')
  expect(summaryLine(`门禁未通过，请裁决：${'x'.repeat(33_000)}`, 20)).toBe(`门禁未通过，请裁决：${'x'.repeat(10)}…`)
  expect(summaryLine('  确认范围  ')).toBe('确认范围')
})

it('tidyText 把旧消息里的原始 JSON 换成要点，运行状态码换成中文', () => {
  expect(tidyText('运行结束：waiting_human')).toBe('运行结束：等人处理')
  const verdicts = JSON.stringify([1, 2, 3, 4].map((i) => ({ subject: `TC-${i}`, category: 'script_defect', rationale: 'x'.repeat(50) })))
  expect(tidyText(`失败判决需要人工裁决：${verdicts}`)).toBe('失败判决需要人工裁决：4 条判决：TC-1（脚本缺陷）、TC-2（脚本缺陷）、TC-3（脚本缺陷） 等')
  const feedback = JSON.stringify({ round: 3, records: [{ reviewer: 'a', summary: 'y'.repeat(80), issues: [{}, {}] }] })
  expect(tidyText(`打回重做：review-prd → prd，第 1 次。${feedback}`)).toBe('打回重做：review-prd → prd，第 1 次。第 3 轮评审：1 位评审提了 2 个问题')
  expect(tidyText(`Lead 回合失败：${JSON.stringify({ subtype: 'error_max_turns', duration_api_ms: 0, result: '轮次用完', session_id: 'z'.repeat(40) })}`)).toBe('Lead 回合失败：error_max_turns：轮次用完')
  // 不是 JSON、或很短的括号：原样
  expect(tidyText('结论见 [1]，另见 {附录}')).toBe('结论见 [1]，另见 {附录}')
})

it('旧事件里贴进提问的门禁结果 JSON 换成一句话', () => {
  const checks = [{ id: 'acceptance', pass: false, details: [{ ac: 'AC-11', pass: true, cases: [] }, { ac: 'AC-13', pass: false, cases: [{ id: 'TC-1', status: 'failed' }] }] }, { id: 'lint', pass: true }]
  expect(tidyText(`门禁未通过，请裁决：${JSON.stringify(checks)}`)).toBe('门禁未通过，请裁决：1 项检查未通过：acceptance（未通过的 AC：AC-13）')
})

it('fmtCost：未上报（undefined / null）写 —，确实是 0 才写 $0，不把未知说成接近 0', () => {
  expect(fmtCost(undefined)).toBe('—')
  expect(fmtCost(null)).toBe('—')
  expect(fmtCost(0)).toBe('$0')
  expect(fmtCost(0.004)).toBe('<$0.01')
  expect(fmtCost(0.0417)).toBe('$0.04')
  expect(fmtCost(123.4)).toBe('$123')
})

it('costOf：没报、部分报（≥ 已知部分 + 覆盖率）、全报三种读法', () => {
  expect(costOf({ inputTokens: 7_430_779, outputTokens: 3_354_396 })).toEqual({ text: '—', title: COST_UNREPORTED })
  expect(costOf({ inputTokens: 0, outputTokens: 0 }).title).toBe('没有用量')
  expect(costOf({ inputTokens: 100, outputTokens: 20, costUsd: 0 })).toMatchObject({ usd: 0, text: '$0' })
  const partial = costOf({ inputTokens: 10_765_175, outputTokens: 29_244, costUsd: 0.0417, unpricedTokens: 10_765_175 })
  expect(partial).toMatchObject({ usd: 0.0417, text: '≥$0.04' })
  expect(partial.coverage).toBeCloseTo(29_244 / 10_794_419)
  expect(partial.title).toBe('成本只覆盖 0.3% 的 Token：10.8M Token 的调用没有上报费用，实际总成本未知')
})

it('fmtShare 与 fmtDateTime', () => {
  expect([0, 0.0004, 0.0027, 0.5, 0.996, 1].map(fmtShare)).toEqual(['0%', '<0.1%', '0.3%', '50%', '99%', '100%'])
  expect(fmtDateTime(undefined)).toBeUndefined()
  const local = new Date(2026, 10, 8, 2, 27).toISOString()
  expect(fmtDateTime(local)).toBe('2026-11-08 02:27')
})
