import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { localSecretValues, resolveSecret, secretStatus, setLocalSecret } from './index.js'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'takt-secrets-')); dirs.push(dir)
  const file = join(dir, 'private/secrets.json')
  vi.stubEnv('TAKT_SECRETS_FILE', file)
  vi.stubEnv('TAKT_UNIT_KEY', '')
  return { dir, file }
}
it('环境优先、本机回退、删除状态，不写进环境；文件和目录只对本人可读', async () => {
  const { dir, file } = await setup()
  expect(secretStatus('TAKT_UNIT_KEY')).toEqual({ name: 'TAKT_UNIT_KEY', source: 'missing' })
  const response = await setLocalSecret('TAKT_UNIT_KEY', 'synthetic-local-value')
  expect(response).toEqual({ name: 'TAKT_UNIT_KEY', source: 'local' })
  expect(process.env.TAKT_UNIT_KEY).toBe('')
  expect(resolveSecret('TAKT_UNIT_KEY')).toBe('synthetic-local-value')
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect((await stat(join(dir, 'private'))).mode & 0o777).toBe(0o700)
  vi.stubEnv('TAKT_UNIT_KEY', 'synthetic-env-value')
  expect(resolveSecret('TAKT_UNIT_KEY')).toBe('synthetic-env-value')
  expect(await setLocalSecret('TAKT_UNIT_KEY', null)).toEqual({ name: 'TAKT_UNIT_KEY', source: 'env' })
  vi.stubEnv('TAKT_UNIT_KEY', '')
  expect(resolveSecret('TAKT_UNIT_KEY')).toBeUndefined()
})
it('并发写不同密钥不丢失；非法名字、损坏文件、符号链接拒绝且异常不含明文', async () => {
  const { dir, file } = await setup()
  await Promise.all(['ONE', 'TWO', 'THREE'].map(name => setLocalSecret(name, `synthetic-${name}`)))
  expect(Object.keys(localSecretValues()).sort()).toEqual(['ONE', 'THREE', 'TWO'])
  await expect(setLocalSecret('../BAD', 'synthetic')).rejects.toThrow('密钥名不合法')
  await writeFile(file, '{synthetic-corrupt-value')
  expect(() => resolveSecret('MISSING')).toThrow('本机密钥库格式错误')
  await rm(file)
  const outside = join(dir, 'outside.json'); await writeFile(outside, '{}')
  await symlink(outside, file)
  await expect(setLocalSecret('KEY', 'synthetic')).rejects.toThrow('符号链接')
  expect(await readFile(outside, 'utf8')).toBe('{}')
})
