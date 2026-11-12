import { describe, expect, it } from 'vitest'
import type { CommandInfo } from '@taktflow/core'
import { commandScope, fieldsOf, initialValues, toInput } from './schema'

const cmd = (input: Record<string, unknown>, extra: Partial<CommandInfo> = {}): CommandInfo => ({ id: 'x', title: 'x', kind: 'command', risk: 'write', input, ...extra })
const schema = {
  type: 'object',
  required: ['requirementId', 'tier'],
  properties: {
    requirementId: { type: 'string' },
    tier: { type: 'string', enum: ['T0', 'T1'] },
    limit: { type: 'integer', default: 3 },
    pending: { type: 'boolean' },
    override: { type: 'object' },
  },
}

describe('fieldsOf', () => {
  it('maps the JSON Schema subset to field specs', () => {
    expect(fieldsOf(cmd(schema)).map((f) => [f.key, f.type, f.required])).toEqual([
      ['requirementId', 'string', true],
      ['tier', 'enum', true],
      ['limit', 'number', false],
      ['pending', 'boolean', false],
      ['override', 'json', false],
    ])
  })
})

describe('initialValues', () => {
  const fields = fieldsOf(cmd(schema))
  it('prefers given values over page context over schema defaults', () => {
    const { values, fromContext } = initialValues(fields, { requirementId: 'REQ-1' }, { tier: 'T1', override: { tier: 'T0' } })
    expect(values).toEqual({ requirementId: 'REQ-1', tier: 'T1', limit: '3', pending: false, override: '{"tier":"T0"}' })
    expect([...fromContext]).toEqual(['requirementId'])
  })
  it('does not mark context when an explicit value is given', () => {
    const { values, fromContext } = initialValues(fields, { requirementId: 'REQ-1' }, { requirementId: 'REQ-9' })
    expect(values.requirementId).toBe('REQ-9')
    expect(fromContext.size).toBe(0)
  })
})

describe('toInput', () => {
  const fields = fieldsOf(cmd(schema))
  it('treats blank strings as missing and reports required titles', () => {
    const r = toInput(fields, { requirementId: '  ', tier: '', limit: '', pending: false, override: '' })
    expect(r.missing).toEqual(['需求', '档位'])
    expect(r.input).toEqual({ pending: false })
  })
  it('parses numbers and JSON, collecting invalid ones', () => {
    const ok = toInput(fields, { requirementId: 'REQ-1', tier: 'T0', limit: '5', pending: true, override: '{"tier":"T1","reason":"r"}' })
    expect(ok).toEqual({ input: { requirementId: 'REQ-1', tier: 'T0', limit: 5, pending: true, override: { tier: 'T1', reason: 'r' } }, missing: [], invalid: [] })
    const bad = toInput(fields, { requirementId: 'REQ-1', tier: 'T0', limit: 'abc', pending: false, override: '{oops' })
    expect(bad.invalid).toEqual(['limit', '手动指定档位'])
  })
})

describe('commandScope', () => {
  it('uses the declared scope when present', () => {
    expect(commandScope(cmd(schema, { scope: ['run'] }))).toEqual(['run'])
  })
  it('infers scope from required context keys (the real registry has no scope)', () => {
    expect(commandScope(cmd({ type: 'object', required: ['runId', 'nodeId', 'groupKey'] }))).toEqual(['run', 'node'])
    expect(commandScope(cmd({ type: 'object', properties: { requirementId: {} } }))).toEqual([])
  })
})

describe('字段名', () => {
  it('常见参数用中文名，JSON 字段注明格式；不认识的参数退回参数名', () => {
    const fields = fieldsOf(cmd({ type: 'object', properties: { requirementId: { type: 'string' }, draft: { type: 'object' }, workflowId: { type: 'string' }, fooBar: { type: 'string' }, hint: { type: 'string', title: '自定义' } } }))
    expect(fields.map((f) => f.title)).toEqual(['需求', '草稿（还没创建的需求）', '流水线', 'fooBar', '自定义'])
    expect(fields[1]!.description).toBe('JSON 格式')
  })
})
