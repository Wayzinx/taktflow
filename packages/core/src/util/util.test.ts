import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './frontmatter.js'
import { newRunId, nextRequirementId } from './ids.js'
import { estimateTokens } from './tokens.js'
import { extractTraceIds } from './trace-ids.js'

describe('frontmatter', () => {
  it('reads the real dev agent template including nested YAML', async () => {
    const text = await readFile(new URL('../../../../templates/agents/dev.md', import.meta.url), 'utf8')
    const { data, body } = parseFrontmatter(text)
    expect(data.role).toBe('dev')
    expect(data.harness).toEqual({ harness: 'codex', effort: 'high', fallback: [{ harness: 'claude-code' }] })
    expect(data.writeScope).toEqual(['src/**', 'package.json', '.takt/workspaces/**/tasks/**'])
    expect(body).toBe(text.slice(text.indexOf('\n---\n') + 5))
  })

  it('preserves body bytes and supports BOM, CRLF, empty headers, and no header', () => {
    expect(parseFrontmatter('\uFEFF---\r\nrole: dev\r\n---\r\n\r\n正文\r\n'))
      .toEqual({ data: { role: 'dev' }, body: '\r\n正文\r\n' })
    expect(parseFrontmatter('---\n---')).toEqual({ data: {}, body: '' })
    expect(parseFrontmatter('---\nrole: dev\n...\nbody')).toEqual({ data: { role: 'dev' }, body: 'body' })
    expect(parseFrontmatter('text\n---\n')).toEqual({ data: {}, body: 'text\n---\n' })
  })

  it.each(['---\nrole: [\n---\n', '---\n- dev\n---\n', '---\nhello\n---\n', '---\nrole: dev'])
    ('rejects malformed header %j', (text) => { expect(() => parseFrontmatter(text)).toThrow(/Frontmatter/) })
})

describe('ids and tokens', () => {
  it('formats the supplied local time and generates a four-hex suffix', () => {
    expect(newRunId(new Date(2026, 10, 4, 3, 2, 1))).toMatch(/^run-20261104-030201-[a-f0-9]{4}$/)
    expect(newRunId()).toMatch(/^run-\d{8}-\d{6}-[a-f0-9]{4}$/)
    expect(() => newRunId(new Date(NaN))).toThrow(/日期/)
  })

  it('increments the largest requirement ID and ignores unrelated IDs', () => {
    expect(nextRequirementId([])).toBe('REQ-001')
    expect(nextRequirementId(['REQ-002', 'REQ-001', 'REQ-010', 'REQ-999-no', 'OTHER-1000'])).toBe('REQ-011')
    expect(nextRequirementId(['REQ-999'])).toBe('REQ-1000')
    expect(nextRequirementId(['REQ-9007199254740993'])).toBe('REQ-9007199254740994')
  })

  it.each(['', 'abcd', 'abcde', '中文字符数', '🙂🙂🙂'])('estimates UTF-8 bytes like decoded text %j', (text) => {
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4))
    expect(estimateTokens(Buffer.from(text))).toBe(estimateTokens(text))
    expect(estimateTokens(new Uint8Array(Buffer.from(text)))).toBe(estimateTokens(text))
  })

  it('extracts unique trace IDs in encounter order', () => {
    expect(extractTraceIds('REQ-001 AC-001-03 AC-2 evidence/TC-API-RULE-042/ REQ-001 中文TC-X-1。'))
      .toEqual(['REQ-001', 'AC-001-03', 'AC-2', 'TC-API-RULE-042', 'TC-X-1'])
    expect(extractTraceIds('nothing req-001 AC-x OTHER-1')).toEqual([])
  })
})
