import { expect, it } from 'vitest'
import { toStrictSchema, dropNullOptionals } from './strict-schema.js'
import { schemaErrors } from '../engine/schema.js'
import { REVIEW_SCHEMA, RESPONSES_SCHEMA } from '../engine/nodes/review-schema.js'
import { completionSchema } from '../engine/completion.js'

it.each([REVIEW_SCHEMA, RESPONSES_SCHEMA, completionSchema(undefined, ['测试通过'])!])('现有协议转换后每层对象封闭且属性全部必填', schema => {
  const before = JSON.stringify(schema)
  const strict = toStrictSchema(schema)
  const inspect = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if ((node as { type?: string }).type === 'object') {
      const object = node as { additionalProperties?: boolean; required: string[]; properties: object }
      expect(object.additionalProperties).toBe(false)
      expect(object.required).toEqual(Object.keys(object.properties))
    }
    for (const value of Object.values(node)) inspect(value)
  }
  inspect(strict)
  expect(JSON.stringify(schema)).toBe(before)
})
it.each([true, { type: 'string' }])('自由键 map 不会静默收紧：%j', additionalProperties => {
  expect(() => toStrictSchema({ type: 'object', additionalProperties })).toThrow('自由键 map')
})
it.each(['oneOf', 'allOf', 'patternProperties', 'if', 'not', 'unevaluatedProperties', 'format'])('未知严格关键字 %s 明确降级', key => {
  expect(() => toStrictSchema({ type: 'object', [key]: {} })).toThrow(`不支持关键字 ${key}`)
})
it('可选字段 nullable、嵌套数组及 $ref 能还原，必填 null 保留且不修改输入', () => {
  const schema = { type: 'object', required: ['required'], properties: {
    required: { type: ['string', 'null'] }, optional: { type: 'string', enum: ['x'] },
    rows: { type: 'array', items: { $ref: '#/$defs/row' } },
  }, $defs: { row: { type: 'object', properties: { name: { type: 'string' }, child: { $ref: '#/$defs/row' } } } } }
  const strict = toStrictSchema(schema)
  const value = { required: null, optional: null, rows: [{ name: null, child: { name: null, child: null } }] }
  expect(schemaErrors(value, strict)).toEqual([])
  const cleaned = dropNullOptionals(value, schema)
  expect(cleaned).toEqual({ required: null, rows: [{ child: {} }] })
  expect(value.optional).toBeNull()
  expect(schemaErrors(cleaned, schema)).toEqual([])
  expect(schemaErrors({ ...value, optional: 'wrong' }, strict)).not.toEqual([])
})
it('anyOf 原分支的可选 null 可以清除', () => {
  const schema = { type: 'object', properties: { item: { anyOf: [
    { type: 'object', properties: { kind: { const: 'a' }, note: { type: 'string' } }, required: ['kind'] },
    { type: 'string' },
  ] } } }
  expect(dropNullOptionals({ item: { kind: 'a', note: null } }, schema)).toEqual({ item: { kind: 'a' } })
})

it('Lead 动作的开放参数必须降级，不得被严格模式悄悄删掉', async () => {
  const { LEAD_TURN_SCHEMA } = await import('../lead/schema.js')
  expect(() => toStrictSchema(LEAD_TURN_SCHEMA)).toThrow('自由键 map')
  expect(schemaErrors({ reply: '派发', actions: [{ type: 'dispatch_task', task: { role: 'dev', title: '实现', instructions: '完成' } }] }, LEAD_TURN_SCHEMA)).toEqual([])
})

it('planner 条目的开放 params 必须降级，不得被严格模式收成空对象', async () => {
  const { PLANNER_SCHEMA } = await import('../engine/nodes/schemas.js')
  expect(() => toStrictSchema(PLANNER_SCHEMA)).toThrow('没列字段的开放对象')
  expect(() => toStrictSchema({ type: 'object', properties: { meta: { type: 'object' } } })).toThrow('$.meta')
  expect(toStrictSchema({ type: 'object', properties: { empty: { type: 'object', additionalProperties: false } } })).toMatchObject({ properties: { empty: { anyOf: [{ additionalProperties: false }, { type: 'null' }] } } })
})
