import { access } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { HarnessAdapter, HarnessRequest, TaktConfig } from '@taktflow/core'
import { testRuntime } from './runtime-test.js'

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
