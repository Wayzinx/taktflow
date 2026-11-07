import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertNoSymlinks, knowledgeFileLock, readJsonFile, type SecretResolver } from '@taktflow/core'
export const isSecretRef = (value: string) => /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$|^secret:[A-Za-z0-9_-]+$/.test(value)
export function createSecretResolver(file = process.env.TAKT_SECRETS_FILE ?? join(homedir(), '.takt/secrets.json')): SecretResolver {
  async function read() { await assertNoSymlinks(dirname(file), file); return await readJsonFile<Record<string, string>>(file) ?? {} }
  return {
    async resolve(ref) {
      if (!isSecretRef(ref)) throw new Error('密钥只能使用环境变量或 secret 引用，请先保存密钥')
      return ref.startsWith('${env:') ? process.env[ref.slice(6, -1)] : (await read())[ref.slice(7)]
    },
    async list() { return Object.keys(await read()).sort() },
    async set(name, value) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('密钥名称不合法，请使用字母、数字、下划线或短横线')
      await knowledgeFileLock(file, async () => {
        const values = await read(); values[name] = value
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${randomUUID()}.tmp`
        try {
          const handle = await open(temp, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify(values)) } finally { await handle.close() }
          await rename(temp, file); await chmod(file, 0o600)
        } finally { await rm(temp, { force: true }) }
      })
    },
  }
}
export function validateSecretFields(value: unknown, schema: Record<string, unknown>): void {
  if (schema.format === 'secret' && (typeof value !== 'string' || !isSecretRef(value))) throw new Error('密钥字段不允许明文，请使用 ${env:NAME} 或 secret:name')
  if (Array.isArray(value)) for (const item of value) validateSecretFields(item, schema.items as Record<string, unknown> ?? {})
  else if (value && typeof value === 'object') {
    const props = schema.properties as Record<string, Record<string, unknown>> ?? {}
    for (const [key, child] of Object.entries(value)) validateSecretFields(child, props[key] ?? schema.additionalProperties as Record<string, unknown> ?? {})
  }
}
