import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveSecret, setLocalSecret } from '@taktflow/core'
import { headers, HttpOperation } from './http.js'
import { createProvider } from './index.js'
import { collectSecrets, createRedactor } from '../redact.js'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'takt-provider-secret-')); dirs.push(dir)
  vi.stubEnv('TAKT_SECRETS_FILE', join(dir, 'secrets.json'))
  vi.stubEnv('LOCAL_UNIT_KEY', '')
  await setLocalSecret('LOCAL_UNIT_KEY', 'synthetic-local-provider-secret')
  return { protocol: 'openai-chat' as const, baseURL: 'http://localhost.invalid/v1', apiKeyEnv: 'LOCAL_UNIT_KEY' }
}
it('HTTP 缺省仍读进程环境，显式解析器才读取本机库；工厂为运行时注入解析器', async () => {
  const config = await setup()
  expect(() => headers(config, config.protocol)).toThrow('missing or empty')
  expect(headers(config, config.protocol, resolveSecret).get('authorization')).toBe('Bearer synthetic-local-provider-secret')
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  const provider = createProvider('local', config)
  expect((await provider.chat({ model: 'fake', messages: [] })).message.content).toBe('ok')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(new Headers((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].headers).get('authorization')).toBe('Bearer synthetic-local-provider-secret')
  expect(process.env.LOCAL_UNIT_KEY).toBe('')
  vi.stubEnv('LOCAL_UNIT_KEY', 'synthetic-process-secret')
  const operation = new HttpOperation(undefined)
  try { await operation.post(new URL(config.baseURL), config, config.protocol, {}) } finally { operation.dispose() }
  expect(new Headers((fetcher.mock.calls[1] as unknown as [unknown, RequestInit])[1].headers).get('authorization')).toBe('Bearer synthetic-process-secret')
})
it('脱敏覆盖未被当前 provider 引用的本机密钥以及被环境值覆盖的本机值', async () => {
  await setup()
  await setLocalSecret('CUSTOM_NAME', 'synthetic-arbitrary-name-value')
  vi.stubEnv('LOCAL_UNIT_KEY', 'synthetic-process-secret')
  const redact = createRedactor(collectSecrets())
  expect(redact('synthetic-local-provider-secret synthetic-arbitrary-name-value synthetic-process-secret')).toBe('[REDACTED] [REDACTED] [REDACTED]')
})
