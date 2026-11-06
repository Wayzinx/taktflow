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
    expect(r.missing).toEqual(['requirementId', 'tier'])
    expect(r.input).toEqual({ pending: false })
  })
  it('parses numbers and JSON, collecting invalid ones', () => {
    const ok = toInput(fields, { requirementId: 'REQ-1', tier: 'T0', limit: '5', pending: true, override: '{"tier":"T1","reason":"r"}' })
    expect(ok).toEqual({ input: { requirementId: 'REQ-1', tier: 'T0', limit: 5, pending: true, override: { tier: 'T1', reason: 'r' } }, missing: [], invalid: [] })
    const bad = toInput(fields, { requirementId: 'REQ-1', tier: 'T0', limit: 'abc', pending: false, override: '{oops' })
    expect(bad.invalid).toEqual(['limit', 'override'])
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
