import { expect, it } from 'vitest'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretResolver, validateSecretFields } from './secrets.js'
it('密钥文件 0600、并发设置不丢数据、只返回名字、环境引用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-secrets-')), file = join(root, 'secrets.json')
  try {
    const secrets = createSecretResolver(file)
    await Promise.all([secrets.set('a', 'value-a'), secrets.set('b', 'value-b')])
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await secrets.list()).toEqual(['a', 'b'])
    expect(await secrets.resolve('secret:a')).toBe('value-a')
    process.env.TAKT_TEST_SECRET = 'env-value'
    expect(await secrets.resolve('${env:TAKT_TEST_SECRET}')).toBe('env-value')
    await expect(secrets.resolve('plain')).rejects.toThrow('引用')
    await expect(secrets.set('../x', 'x')).rejects.toThrow('名称')
    expect(() => validateSecretFields({ headers: { Authorization: 'plain' } }, { properties: { headers: { additionalProperties: { format: 'secret' } } } })).toThrow('明文')
  } finally { delete process.env.TAKT_TEST_SECRET; await rm(root, { recursive: true, force: true }) }
})
