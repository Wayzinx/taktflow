/**
 * mock 命令注册表必须与真实注册表同形（评审发现 #8：mock 自造的 route.preview schema 掩盖了改档丢失的 bug）。
 * 直接读 core 源码里的注册表比对 id / 标题 / 风险 / 权限 / input schema。
 */
import { describe, expect, it } from 'vitest'
import { createCommandRegistry } from '../../core/src/commands/index.js'
import { evalCommandSpecs } from '../../core/src/commands/eval-commands.js'
import { MOCK_COMMANDS, runMockCommand } from '../src/api/mock-commands'

const real = createCommandRegistry({ stores: {} as never, extensions: evalCommandSpecs({ stores: {} } as never) }).list()
const strip = (c: { id: string; title: string; kind: string; risk: string; minRole?: string; input: unknown }) => ({ id: c.id, title: c.title, kind: c.kind, risk: c.risk, minRole: c.minRole, input: c.input })

describe('MOCK_COMMANDS', () => {
  it('has exactly the real commands plus the server extension lesson.update', () => {
    expect(MOCK_COMMANDS.map((c) => c.id).sort()).toEqual([...real.map((c) => c.id), 'lesson.update'].sort())
  })
  it('matches every real command shape', () => {
    for (const c of real) expect(strip(MOCK_COMMANDS.find((m) => m.id === c.id)!)).toEqual(strip(c))
  })
  it('validates like the real registry', async () => {
    expect(await runMockCommand('nope', { input: {} }, {})).toMatchObject({ ok: false })
    expect(await runMockCommand('run.cancel', { input: {} }, {})).toMatchObject({ ok: false, message: '缺少参数：runId' })
    expect(await runMockCommand('run.cancel', { input: { runId: 'r' } }, {})).toMatchObject({ ok: false, message: '写操作必须说明原因' })
    expect(await runMockCommand('run.cancel', { input: { runId: 'r' }, reason: '测试' }, {})).toMatchObject({ ok: true })
  })
})
