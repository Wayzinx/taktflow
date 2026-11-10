import { expect, it } from 'vitest'
import { summaryLine, tidyText } from './format'

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
