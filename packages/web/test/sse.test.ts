import { describe, expect, it } from 'vitest'
import { parseSse } from '../src/api/sse'

describe('parseSse', () => {
  it('splits complete events, keeps the partial tail, skips comments', () => {
    const r = parseSse(': keep-alive\n\ndata: {"a":1}\n\ndata: {"b"')
    expect(r.data).toEqual(['{"a":1}'])
    expect(r.rest).toBe('data: {"b"')
    expect(parseSse(r.rest + ':2}\n\n').data).toEqual(['{"b":2}'])
  })
  it('joins multi-line data and handles CRLF', () => {
    expect(parseSse('data: a\r\ndata: b\r\n\r\n').data).toEqual(['a\nb'])
  })
})
