import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SecretStatus } from '../api.js'
import { withFileLock } from '../store/file-lock.js'
import { assertNoSymlinks } from '../store/fs-utils.js'

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/
export function secretsPath(): string {
  return process.env.TAKT_SECRETS_FILE || join(homedir(), '.config', 'takt', 'secrets.json')
}

export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) throw new Error('密钥名不合法；请使用大写字母、数字和下划线，且不能以数字开头')
}

// 同步读取使日志脱敏与同步目录视图也能覆盖本机密钥；不缓存明文，不修改 process.env。
export function localSecretValues(): Record<string, string> {
  let fd: number
  try { fd = openSync(secretsPath(), constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('无法读取本机密钥库；请检查文件权限与路径')
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error()
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.entries(value).some(([name, secret]) => !SECRET_NAME.test(name) || typeof secret !== 'string')) throw new Error()
    return value as Record<string, string>
  } catch { throw new Error('本机密钥库格式错误；请修复 secrets.json 后重试') }
  finally { closeSync(fd) }
}

export function resolveSecret(name: string): string | undefined {
  const env = process.env[name]
  if (env?.trim()) return env
  const local = localSecretValues()[name]
  return local?.trim() ? local : undefined
}

export function secretStatus(name: string): SecretStatus {
  return { name, source: process.env[name]?.trim() ? 'env' : localSecretValues()[name]?.trim() ? 'local' : 'missing' }
}

export async function setLocalSecret(name: string, value: string | null): Promise<SecretStatus> {
  assertSecretName(name)
  if (value !== null && !value.trim()) throw new Error('密钥值不能为空；请填写 value 或使用 DELETE 删除')
  const file = secretsPath()
  const dir = dirname(file)
  await assertNoSymlinks(dir, file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  return withFileLock(file, async () => {
    const values = localSecretValues()
    if (value === null) delete values[name]
    else values[name] = value
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(values)); await handle.sync() } finally { await handle.close() }
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
    return secretStatus(name)
  })
}
