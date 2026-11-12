import { expect, it } from 'vitest'
import { isEnvFailure } from './recovery'

it('认证 / 环境类错误先引导去检查模型与 Harness（TF-013）', () => {
  expect(isEnvFailure('Claude Code：Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true)
  expect(isEnvFailure('spawn claude ENOENT')).toBe(true)
  expect(isEnvFailure('401 Unauthorized: invalid API key')).toBe(true)
  expect(isEnvFailure('模型登录已过期')).toBe(true)
})

it('普通业务失败仍只给重试（TF-013）', () => {
  expect(isEnvFailure('测试用例第 3 条未通过')).toBe(false)
  expect(isEnvFailure('')).toBe(false)
  expect(isEnvFailure(undefined)).toBe(false)
})
