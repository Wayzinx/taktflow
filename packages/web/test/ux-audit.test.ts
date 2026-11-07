import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const audit = (dir: string) => {
  const r = spawnSync(process.execPath, ['scripts/ux-audit.mjs', '--json', dir], { cwd: WEB, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout) as { errors: Array<{ file: string; rule: string }>; warnings: Array<{ file: string; rule: string }> } }
}

describe('ux-audit', () => {
  const { code, out } = audit('test/fixtures/ux-audit')
  const of = (file: string) => [...out.errors, ...out.warnings].filter((f) => f.file.endsWith(file)).map((f) => f.rule).sort()
  it('reports loading text, async list without empty state, and CLI hints without a nearby button', () => {
    expect(of('bad.tsx')).toEqual(['async-empty', 'cli-hint', 'loading-text'])
    expect(code).toBe(1)
  })
  it('honours placeholders, nearby buttons and ux-audit: ok', () => {
    expect(of('ok.tsx')).toEqual([])
  })
})
