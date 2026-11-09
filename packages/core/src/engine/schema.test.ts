import { describe, expect, it } from 'vitest'
import { extractStructured, schemaErrors, validateSchema } from './schema.js'

describe('完整 JSON Schema 与中文错误', () => {
  it.each([
    [{ checks: [{ pass: 'yes' }] }, { type: 'object', properties: { checks: { type: 'array', items: { type: 'object', properties: { pass: { type: 'boolean' } } } } } }, '$.checks[0].pass：应为 boolean'],
    [false, { type: ['string', 'null'] }, '$：应为 string / null'],
    [{}, { required: ['description'] }, '$：缺少必填字段 description'],
    [{ extra: 1 }, { type: 'object', additionalProperties: false }, '$：不允许的字段 extra'],
    ['x', { enum: ['approve', 'request_changes', 'reject'] }, '$：取值须为 approve / request_changes / reject 之一'],
    [2, { const: 1 }, '$：取值须为 1'],
    [[], { minItems: 1 }, '$：至少需要 1 项'],
    [[1, 2], { maxItems: 1 }, '$：最多允许 1 项'],
    ['a', { minLength: 2 }, '$：长度至少为 2'],
    ['abc', { maxLength: 2 }, '$：长度最多为 2'],
    ['a', { pattern: '^b' }, '$：须匹配模式 ^b'],
    [1, { minimum: 2 }, '$：须大于或等于 2'],
    [3, { maximum: 2 }, '$：须小于或等于 2'],
    [false, { anyOf: [{ type: 'string' }, { type: 'number' }] }, '$：须满足至少一种候选结构'],
    [1, { oneOf: [{ type: 'number' }, { type: 'integer' }] }, '$：须且只能满足一种候选结构'],
    [0, { allOf: [{ minimum: 1 }, { maximum: 4 }] }, '$：须大于或等于 1'],
    [{ 'a/b~c': 'bad' }, { properties: { 'a/b~c': { type: 'number' } } }, '$["a/b~c"]：应为 number'],
  ])('%j 按 %j 返回中文路径', (value, schema, error) => {
    expect(schemaErrors(value, schema as Record<string, unknown>)).toContain(error)
    expect(() => validateSchema(value, schema as Record<string, unknown>)).toThrow(error)
  })
  it('本地引用、多个错误、路径前缀和对象缓存不改变校验语义', () => {
    const schema = { $defs: { issue: { type: 'object', required: ['description'] } }, properties: { issues: { type: 'array', items: { $ref: '#/$defs/issue' } } } }
    expect(schemaErrors({ issues: [{}, {}, {}] }, schema)).toEqual([0, 1, 2].map(i => `$.issues[${i}]：缺少必填字段 description`))
    expect(() => validateSchema({ issues: [{}] }, schema, '$.input')).toThrow('$.input.issues[0]：缺少必填字段 description')
    expect(schemaErrors({ issues: [{ description: 'ok' }] }, schema)).toEqual([])
    expect(schemaErrors({ id: null }, { properties: { id: { type: ['string', 'null'] } } })).toEqual([])
  })
})

describe('结构化提取', () => {
  const schema = { type: 'object', required: ['checks'], properties: { checks: { type: 'array' } } }
  const data = { checks: [] }
  const block = (text: string) => `\`\`\`json\n${text}\n\`\`\``
  it('单块、原始 JSON、多值按最后一个合法结构选取', () => {
    expect(extractStructured(block(JSON.stringify(data)), schema)).toEqual({ value: data })
    expect(extractStructured(JSON.stringify(data), schema)).toEqual({ value: data })
    expect(extractStructured(block(`${JSON.stringify(schema)}\n${JSON.stringify(data)}`), schema)).toEqual({ value: data })
    expect(extractStructured(block(`${JSON.stringify(data)}\n${JSON.stringify(schema)}`), schema)).toEqual({ value: data })
    expect(extractStructured(block('{} false null 7 "x"'))).toEqual({ value: 'x' })
    expect(extractStructured(block('{} null false'), { type: 'null' })).toEqual({ value: null })
    expect(extractStructured(block('{} {}'), schema)).toEqual({ value: {} })
  })
  it('报告提取问题，不回退旧块，也不把格式问题混成业务失败', () => {
    expect(extractStructured('说明')).toEqual({ problem: '没有 json 代码块' })
    expect(extractStructured(block('{}') + '\n```json\n{}')).toEqual({ problem: 'json 代码块未闭合' })
    expect(extractStructured(block('{broken}')).problem).toMatch(/^json 代码块无法解析：/)
  })
})
