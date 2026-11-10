import { expect, it } from 'vitest'
import { summaryLine } from './format'

it('summaryLine 把多行并成一行并截断，短文本原样返回', () => {
  expect(summaryLine('交付校验未通过：\n· acceptance：2 条 AC 未通过\n通过：放行')).toBe('交付校验未通过： · acceptance：2 条 AC 未通过 通过：放行')
  expect(summaryLine(`门禁未通过，请裁决：${'x'.repeat(33_000)}`, 20)).toBe(`门禁未通过，请裁决：${'x'.repeat(10)}…`)
  expect(summaryLine('  确认范围  ')).toBe('确认范围')
})
