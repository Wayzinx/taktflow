import { afterEach, expect, it, vi } from 'vitest'
import { collectSecrets, createRedactor, redactValue } from './redact.js'

afterEach(() => vi.unstubAllEnvs())

it('shares credential discovery without treating ordinary configuration as secrets', () => {
  vi.stubEnv('TOKENIZERS_PARALLELISM', 'false')
  vi.stubEnv('MONKEY_PATCH', '1')
  vi.stubEnv('SYNTHETIC_CONNECTION', 'synthetic-connection-value')
  const redact = createRedactor(collectSecrets(undefined, { fixture: {
    protocol: 'openai-chat', apiKeyEnv: 'SYNTHETIC_CONNECTION',
    headers: { Authorization: 'Bearer synthetic-header-value', 'Content-Type': 'application/json' },
    baseURL: 'https://test-user:synthetic%2Dpassword@example.invalid/v1?api_key=synthetic-query-value&api-version=2024&enabled=false',
  } }))
  expect(redact('const enabled = false; retries = 1; application/json; 2024')).toBe('const enabled = false; retries = 1; application/json; 2024')
  for (const secret of ['synthetic-connection-value', 'synthetic-header-value', 'synthetic-password', 'synthetic%2Dpassword', 'synthetic-query-value']) {
    expect(redact(`error: ${secret}`)).toBe('error: [REDACTED]')
  }
  expect(redact('sk-synthetic1234567890')).toBe('[REDACTED]')
})

it('known numeric secrets are masked inside JSON objects and arrays without invalid JSON', () => {
  vi.stubEnv('PASSWORD', '123456')
  const redact = createRedactor(collectSecrets())
  expect(JSON.parse(redact('{"password":123456}'))).toEqual({ password: '[REDACTED]' })
  expect(JSON.parse(redact('[123456]'))).toEqual(['[REDACTED]'])
  expect(redactValue({ structured: [123456], ok: true }, redact)).toEqual({ structured: ['[REDACTED]'], ok: true })
  expect(redact('{"enabled":false,"retries":1}')).toBe('{"enabled":false,"retries":1}')
})
