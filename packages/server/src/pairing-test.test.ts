import { access } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { HarnessAdapter, HarnessRequest, TaktConfig } from '@taktflow/core'
import { testRuntime } from './runtime-test.js'

it.each(['OK。', ' ok! ', '\nOk\n'])('搭配测试接受首尾标点和大小写：%j', async finalText => {
  const h: HarnessAdapter = { id: 'h', displayName: 'h', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText }) }
  expect(await testRuntime({ project: { name: '' }, workflows: [] }, { target: { kind: 'pairing', harness: 'h' }, allowBilled: true }, async () => ({ h }))).toMatchObject({ ok: true })
})

it('搭配失败消息包含收到的内容', async () => {
  const h: HarnessAdapter = { id: 'h', displayName: 'h', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '好的' }) }
  expect(await testRuntime({ project: { name: '' }, workflows: [] }, { target: { kind: 'pairing', harness: 'h' }, allowBilled: true }, async () => ({ h }))).toMatchObject({ ok: false, message: '搭配未返回 OK（收到：好的）' })
})

it('搭配失败内容先脱敏再截断到 80 字，不把失败响应 OK 判成功', async () => {
  const secret = 'pairing-test-secret-value'
  vi.stubEnv('TAKT_PAIRING_TEST_SECRET', secret)
  try {
    const h: HarnessAdapter = { id: 'h', displayName: 'h', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: secret + '好'.repeat(100) }) }
    const config: TaktConfig = { project: { name: '' }, workflows: [], providers: { p: { protocol: 'openai-responses', apiKeyEnv: 'TAKT_PAIRING_TEST_SECRET' } } }
    const result = await testRuntime(config, { target: { kind: 'pairing', harness: 'h' }, allowBilled: true }, async () => ({ h }))
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain(secret)
    expect([...result.message.match(/收到：(.*)）/s)![1]!]).toHaveLength(80)
    h.run = async () => ({ ok: false, finalText: 'OK!', error: '任务失败' })
    expect(await testRuntime(config, { target: { kind: 'pairing', harness: 'h' }, allowBilled: true }, async () => ({ h }))).toMatchObject({ ok: false, message: '任务失败（收到：OK!）' })
  } finally { vi.unstubAllEnvs() }
})

it.each(['builtin', 'direct'])('搭配测试 %s 的结果、用量、临时目录清理', async mode => {
  let observed: HarnessRequest | undefined
  const run = vi.fn(async (req: HarnessRequest) => { observed = req; return { ok: true, finalText: 'OK', usage: { inputTokens: 1, outputTokens: 2 } } })
  const h: HarnessAdapter = { id: 'h', displayName: 'h', capabilities: { customProvider: true, providerProtocols: ['openai-responses'] }, available: async () => ({ ok: true }), run }
  const config: TaktConfig = { project: { name: 'test' }, workflows: [], providers: { p: { protocol: 'openai-responses' } }, models: { m: { provider: 'p', id: 'model' } } }
  const result = await testRuntime(config, { target: { kind: 'pairing', harness: 'h', ...(mode === 'direct' ? { model: 'm' } : {}) }, allowBilled: true }, async () => ({ h }))
  expect(result).toMatchObject({ ok: true, billed: true })
  expect(JSON.parse(result.detail!)).toMatchObject({ pairing: { mode }, usage: { inputTokens: 1, outputTokens: 2 } })
  expect(observed?.timeoutMs).toBe(120_000)
  await expect(access(observed!.cwd)).rejects.toThrow()
})
it('未授权、停用、探测失败不运行；错误文本脱敏且不把错误正文当成功', async () => {
  const config: TaktConfig = { project: { name: '' }, workflows: [] }
  const run = vi.fn(async () => ({ ok: true, finalText: '不是 OK' }))
  const h: HarnessAdapter = { id: 'h', displayName: 'h', available: async () => ({ ok: false, reason: '未安装' }), run }
  const target = { kind: 'pairing' as const, harness: 'h' }
  await expect(testRuntime(config, { target }, async () => ({ h }))).rejects.toThrow('allowBilled')
  expect(await testRuntime(config, { target, allowBilled: true }, async () => ({ h }))).toMatchObject({ ok: false, billed: false, message: '未安装' })
  expect(run).not.toHaveBeenCalled()
  h.available = async () => ({ ok: true })
  expect(await testRuntime(config, { target, allowBilled: true }, async () => ({ h }))).toMatchObject({ ok: false, billed: true })
})

it('账号未登录只关闭自带格，API 三种直连仍可用', async () => {
  const { pairingMatrix } = await import('./pairings.js')
  const config: TaktConfig = { project: { name: '' }, workflows: [], providers: {
    chat: { protocol: 'openai-chat' }, responses: { protocol: 'openai-responses' }, anthropic: { protocol: 'anthropic-messages' },
  } }
  const matrix = pairingMatrix(config, [{ id: 'dsh', displayName: 'DSH', source: 'builtin', available: true,
    ownReady: false, ownReason: '请登录', roles: [], capabilities: { customProvider: true, providerProtocols: ['openai-chat', 'openai-responses', 'anthropic-messages'] } }])
  expect(matrix[0]).toMatchObject({ provider: null, status: 'unavailable', reason: '请登录' })
  expect(matrix.slice(1).map(row => row.status)).toEqual(['direct', 'direct', 'direct'])
})
