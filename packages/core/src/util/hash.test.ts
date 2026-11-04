import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from './hash.js'

describe('hash', () => {
  it('hashes strings and bytes with SHA-256', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256(Buffer.from('中文'))).toBe(sha256('中文'))
  })

  it('sorts all object keys without reordering arrays', () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }, 0], a: { '2': 'two', '10': 'ten' } }))
      .toBe('{"a":{"10":"ten","2":"two"},"z":[{"a":1,"b":2},0]}')
    expect(canonicalJson(JSON.parse('{"__proto__":{"z":1,"a":2},"x":0}')))
      .toBe('{"__proto__":{"a":2,"z":1},"x":0}')
  })

  it('preserves JSON persistence semantics for optional fields and arrays', () => {
    const value = {
      nodeId: undefined,
      data: { missing: undefined, values: [undefined, , NaN, Infinity, -0, true, null, '"\n'] },
      date: new Date('2026-11-04T00:00:00Z'),
    }
    expect(canonicalJson(value)).toBe(canonicalJson(JSON.parse(JSON.stringify(value))))
    expect(JSON.parse(canonicalJson(value))).toEqual({
      data: { values: [null, null, null, null, 0, true, null, '"\n'] },
      date: '2026-11-04T00:00:00.000Z',
    })
    expect(canonicalJson({ toJSON: () => ({ z: 1, a: 2 }) })).toBe('{"a":2,"z":1}')
  })

  it.each([null, true, false, 42, 'text', []])('supports JSON root %j', (value) => {
    expect(canonicalJson(value)).toBe(JSON.stringify(value))
  })

  it('rejects values that cannot be persisted as JSON', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(TypeError)
    expect(() => canonicalJson(1n)).toThrow(TypeError)
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
  })
})
