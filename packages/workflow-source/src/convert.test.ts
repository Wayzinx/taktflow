import { expect, it } from 'vitest'
import { convertWorkflowSource } from './convert.js'
import { parseWorkflowSource } from './parse.js'
const object = "{ id: 'demo', title: '示例', version: '1', stages: [], nodes: [] }"
it.each([`// 原注释\nexport default ${object}`, `// 原注释\nconst flow = ${object};\nexport default flow`])('转换对象写法并保留注释', (source) => {
  const result = convertWorkflowSource(source)
  expect(result.ok, result.reason).toBe(true)
  expect(result.source).toContain('// 原注释')
  expect(result.source).toContain("import { defineWorkflow } from '@taktflow/core'")
  expect(parseWorkflowSource(result.source!).model.editable).toBe(true)
})
it('补现有 import，保留其它 import 和注释，已可编辑时不改写', () => {
  const result = convertWorkflowSource(`import { script /* 保留 */ } from '@taktflow/core'\nimport fs from 'node:fs'\nexport default ${object}`)
  expect(result.source).toContain('script /* 保留 */')
  expect(result.source).toContain("import fs from 'node:fs'")
  expect(convertWorkflowSource(result.source!)).toEqual({ ok: false, reason: '已是可编辑写法' })
})
it('无法确定性转换或解析不通过时拒绝', () => {
  for (const source of [`export default factory()`, `const x = ${object}; x.title = '变化'; export default x`, 'export default { ...other }']) expect(convertWorkflowSource(source).ok).toBe(false)
})
