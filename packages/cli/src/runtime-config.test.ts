import { afterEach, expect, it, vi } from 'vitest'
import type { TaktConfig } from '@taktflow/core'
import { normalizeConfig, redactConfigError } from './runtime-config.js'

afterEach(() => vi.unstubAllEnvs())

it('共享脱敏覆盖环境变量、header、URL 凭据与查询参数，保留诊断上下文', () => {
  vi.stubEnv('TAKT_REDACTION_TEST_KEY', 'synthetic-environment-secret')
  const config: TaktConfig = {
    project: { name: 'redact' }, workflows: [],
    providers: { test: {
      protocol: 'openai-chat', apiKeyEnv: 'TAKT_REDACTION_TEST_KEY',
      headers: { Authorization: 'Bearer synthetic-header-secret', 'x-api-key': 'synthetic-custom-secret' },
      baseURL: 'https://fixture:synthetic-password@localhost/v1?api_key=synthetic-query-secret',
    } },
  }
  const message = 'provider failed 401: synthetic-environment-secret Bearer synthetic-header-secret synthetic-custom-secret https://fixture:synthetic-password@localhost/v1?api_key=synthetic-query-secret'
  const result = redactConfigError(config, new Error(message))
  expect(result).toContain('provider failed 401:')
  expect(result).toContain('[REDACTED]')
  for (const secret of ['synthetic-environment-secret', 'synthetic-header-secret', 'synthetic-custom-secret', 'synthetic-password', 'synthetic-query-secret']) expect(result).not.toContain(secret)
})

it.each([null, { test: null }, { test: { protocol: 'openai-chat', headers: { bad: 42 } } }])('坏 providers=%j 不让脱敏错误遮盖配置诊断', (providers) => {
  const config = { project: { name: 'invalid' }, workflows: [], providers } as unknown as TaktConfig
  let error: unknown
  try { normalizeConfig(config) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  expect(redactConfigError(config, error)).toBe((error as Error).message)
})

it('错误 header 类型与可用凭据共存时仍收集可用字段', () => {
  vi.stubEnv('TAKT_REDACTION_TEST_KEY', 'synthetic-environment-secret')
  const config = { project: { name: 'invalid' }, workflows: [], providers: {
    broken: null,
    valid: { protocol: 'openai-chat', apiKeyEnv: 'TAKT_REDACTION_TEST_KEY', headers: { bad: null, Authorization: 'Bearer synthetic-header-secret' } },
  } } as unknown as TaktConfig
  const result = redactConfigError(config, 'invalid headers synthetic-environment-secret synthetic-header-secret')
  expect(result).toBe('invalid headers [REDACTED] [REDACTED]')
})
