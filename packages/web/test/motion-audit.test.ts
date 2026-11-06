import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/motion-audit.mjs', import.meta.url))
const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

interface Finding {
  file: string
  line: number
  rule: string
  level: 'error' | 'warn'
}

/** 把 fixture 写进临时目录，跑脚本拿 --json 结果。 */
function audit(files: Record<string, string>): { code: number; findings: Finding[] } {
  const dir = mkdtempSync(join(tmpdir(), 'motion-audit-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--json', dir], { encoding: 'utf8' })
    return { code: 0, findings: JSON.parse(out).findings }
  } catch (e) {
    const err = e as { status: number; stdout: string }
    return { code: err.status, findings: JSON.parse(err.stdout).findings }
  }
}
const rules = (r: { findings: Finding[] }) => r.findings.map((f) => f.rule)

describe('motion-audit', () => {
  it('passes clean CSS', () => {
    const r = audit({ 'a.css': '.a { transition: opacity 120ms var(--ease), transform 120ms; }\n' })
    expect(r.code).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('flags transition: all and transition-property: all', () => {
    expect(rules(audit({ 'a.css': '.a { transition: all 200ms; }\n' }))).toEqual(['transition-all'])
    expect(rules(audit({ 'a.css': '.a { transition-property: opacity, all; }\n' }))).toEqual(['transition-all'])
  })

  it('flags size transitions wherever the property sits in the shorthand', () => {
    expect(rules(audit({ 'a.css': '.a { transition: width 200ms ease; }\n' }))).toEqual(['size-transition'])
    // 时长写在属性前面也是合法 CSS
    expect(rules(audit({ 'a.css': '.a { transition: 200ms width ease; }\n' }))).toEqual(['size-transition'])
    expect(rules(audit({ 'a.css': '.a { transition: 120ms cubic-bezier(0.2, 1, 0.3, 1) max-height; }\n' }))).toEqual(['size-transition'])
    expect(rules(audit({ 'a.css': '.a { transition: var(--dur) var(--ease) opacity; }\n' }))).toEqual([])
  })

  it('flags scale(0) and warns on scale below 0.985', () => {
    const r = audit({ 'a.css': '.a { transform: scale(0); }\n.b { transform: scale(0.9); }\n.c { transform: scale(0.99); }\n' })
    expect(r.findings.map((f) => [f.rule, f.level, f.line])).toEqual([
      ['scale-zero', 'error', 1],
      ['scale-too-small', 'warn', 2],
    ])
  })

  it('requires a reduced-motion fallback for infinite animations', () => {
    const bad = audit({ 'a.css': '@keyframes pulse { to { opacity: 0.5; } }\n.dot { animation: pulse 1.2s infinite; }\n' })
    expect(rules(bad)).toEqual(['infinite-no-reduce'])
    expect(bad.code).toBe(1)
    const ok = audit({
      'a.css': "@keyframes pulse { to { opacity: 0.5; } }\n.x[data-state='on'] .dot { animation: pulse 1.2s infinite; }\n@media (prefers-reduced-motion: reduce) { .x .dot { animation: none; } }\n",
    })
    expect(ok.findings).toEqual([])
  })

  it('treats infinite animations inside prefers-reduced-motion: no-preference as covered', () => {
    const r = audit({ 'a.css': '@keyframes spin { to { transform: rotate(1turn); } }\n@media (prefers-reduced-motion: no-preference) { .s { animation: spin 1s linear infinite; } }\n' })
    expect(r.findings).toEqual([])
  })

  it('flags duplicate keyframes across files', () => {
    const r = audit({ 'a.css': '@keyframes fade { to { opacity: 1; } }\n', 'b.css': '@keyframes fade { to { opacity: 0; } }\n' })
    expect(rules(r)).toEqual(['dup-keyframes', 'dup-keyframes'])
  })

  it('checks inline styles in TSX', () => {
    expect(rules(audit({ 'a.tsx': "export const s = { transition: 'height 200ms' }\n" }))).toEqual(['size-transition'])
    expect(rules(audit({ 'a.tsx': "export const s = { animation: 'pulse 1s infinite' }\n" }))).toEqual(['infinite-no-reduce'])
  })

  it('honours the motion-audit: ok exemption on the same or previous line', () => {
    expect(audit({ 'a.css': '.a {\n  /* motion-audit: ok 一次性展开 */\n  transition: height 200ms;\n}\n' }).findings).toEqual([])
    expect(audit({ 'a.css': '.a { transition: height 200ms; /* motion-audit: ok 测试 */ }\n' }).findings).toEqual([])
  })
})
