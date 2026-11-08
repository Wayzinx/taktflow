import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { expect, it } from 'vitest'
import workflow from '../../../../templates/workflows/taktflow-standard.workflow.js'

it('作者版模板满足受限子集；除 M5 职责与依据外与示例一致', async () => {
  const source = await readFile(new URL('../../../../templates/workflows/taktflow-standard.workflow.ts', import.meta.url), 'utf8')
  const example = await readFile(new URL('../../../../examples/standard-delivery/workflows/taktflow-standard.workflow.ts', import.meta.url), 'utf8')
  const withoutCapture = (text: string) => text.replace(/, (?:references|checklist): \[[^\]]*\]/g, '')
  expect(withoutCapture(example)).toBe(withoutCapture(source))
  expect(withoutCapture(await readFile(new URL('../../../../examples/standard-delivery/workflows/taktflow-standard.hooks.ts', import.meta.url), 'utf8')))
    .toBe(withoutCapture(await readFile(new URL('../../../../templates/workflows/taktflow-standard.hooks.ts', import.meta.url), 'utf8')))
  const reviews = workflow.nodes.filter(node => node.kind === 'review')
  expect(reviews.find(node => node.id === 'review-prd')?.references).toEqual(['spec/clarify.md'])
  expect(reviews.find(node => node.id === 'review-design')?.references).toEqual(['spec/prd.md'])
  expect(reviews.find(node => node.id === 'review-cases')?.references).toEqual(['spec/prd.md', 'design/contracts*'])
  expect(reviews.every(node => node.reviewers.every(reviewer => reviewer.checklist && reviewer.checklist.length >= 3 && reviewer.checklist.length <= 5))).toBe(true)
  const file = ts.createSourceFile('taktflow-standard.workflow.ts', source, ts.ScriptTarget.Latest, true)
  const exported = file.statements.find(ts.isExportAssignment)!
  expect(ts.isCallExpression(exported.expression)).toBe(true)
  const call = exported.expression as ts.CallExpression
  expect(call.expression.getText(file)).toBe('defineWorkflow')
  const object = call.arguments[0] as ts.ObjectLiteralExpression
  expect(ts.isObjectLiteralExpression(object)).toBe(true)
  function prop(object: ts.ObjectLiteralExpression, key: string) {
    return (object.properties.find((item) => item.name?.getText(file) === key) as ts.PropertyAssignment).initializer
  }
  expect(ts.isArrayLiteralExpression(prop(object, 'stages'))).toBe(true)
  const constructors = new Set(['agent', 'script', 'gate', 'human', 'judge', 'loop', 'planner', 'review', 'subflow'])
  function check(nodes: ts.Expression) {
    expect(ts.isArrayLiteralExpression(nodes)).toBe(true)
    for (const node of (nodes as ts.ArrayLiteralExpression).elements) {
      expect(ts.isCallExpression(node)).toBe(true)
      const call = node as ts.CallExpression
      expect(constructors.has(call.expression.getText(file))).toBe(true)
      const object = call.arguments[0] as ts.ObjectLiteralExpression
      expect(ts.isObjectLiteralExpression(object)).toBe(true)
      if (call.expression.getText(file) === 'loop') check(prop(object, 'body'))
    }
  }
  check(prop(object, 'nodes'))
  expect(workflow.nodes.filter((node) => node.kind === 'review').map((node) => node.id))
    .toEqual(['review-prd', 'review-design', 'review-cases', 'review-scripts'])
})
