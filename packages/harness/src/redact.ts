import { localSecretValues, resolveSecret } from '@taktflow/core'
import type { HarnessRequest, ModelProvider, ProviderConfig } from '@taktflow/core'

const REDACTED = '[REDACTED]'

/** 环境变量名像密钥时才把它的值当密钥，避免拿 PATH 之类的普通值做全文替换。 */
const SENSITIVE_ENV_NAME = /(?:API[_-]?KEY|ACCESS[_-]?(?:KEY|TOKEN)|AUTH[_-]?TOKEN|SECRET(?:_ACCESS)?[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|TOKEN|AUTHORIZATION)$/i

/** 常见密钥格式：没有对应环境变量也按形状脱敏，避免 agent 从别处抄到密钥。 */
const KEY_FORMATS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b[Bb]earer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/g,
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 本次运行可能泄露的密钥值：provider.apiKeyEnv、名字像密钥的环境变量、敏感 header（去重，仅用于内存内替换）。 */
export function collectSecrets(req?: HarnessRequest, providers: Record<string, ModelProvider | ProviderConfig> = {}): string[] {
  const local = localSecretValues()
  const values: Array<string | undefined> = [...Object.values(local), ...Object.keys(local).map(name => process.env[name])]
  for (const source of [process.env, req?.env ?? {}]) {
    for (const [name, value] of Object.entries(source)) if (SENSITIVE_ENV_NAME.test(name)) values.push(value)
  }
  for (const config of [...Object.values(providers ?? {}), ...(req?.provider ? [req.provider] : [])]) {
    // 配置错误的诊断也复用本函数，尚未通过校验的条目不能覆盖原始错误。
    if (!config || typeof config !== 'object' || 'chat' in config) continue
    if (config.apiKeyEnv) values.push(req?.env?.[config.apiKeyEnv], resolveSecret(config.apiKeyEnv))
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (typeof value !== 'string') continue
      if (!SENSITIVE_ENV_NAME.test(name) && !/^(?:authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)) continue
      values.push(value)
      const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)
      if (auth) values.push(auth[1])
    }
    if (!config.baseURL) continue
    try {
      const url = new URL(config.baseURL)
      const credentials = [url.username, url.password]
      for (const [name, value] of url.searchParams) {
        if (SENSITIVE_ENV_NAME.test(name) || /^(?:key|auth|authorization)$/i.test(name)) credentials.push(value)
      }
      for (const value of credentials) {
        if (!value) continue
        values.push(value)
        try { values.push(decodeURIComponent(value)) } catch { /* 编码无效时仍遮盖原值。 */ }
      }
    } catch { /* URL 错误由 provider 校验报告。 */ }
  }
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
}

/**
 * 脱敏器：先替换已知密钥值（长的优先，避免短值先命中留下残段），再按常见格式兜底。
 * 替换标记不含引号等结构字符，落在 JSON 字符串里也不会破坏协议行。
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  // 不按长度忽略密钥；多行值的片段也要遮盖，否则逐行回调会先泄露半段。
  const variants = secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1), ...secret.split(/\r\n|\r|\n/)])
  const literals = [...new Set(variants)].filter(Boolean)
    .sort((a, b) => b.length - a.length).map(escapeRegExp)
  const literalPattern = literals.length ? new RegExp(literals.join('|'), 'g') : undefined
  const mask = (text: string): string => {
    const masked = literalPattern ? text.replace(literalPattern, REDACTED) : text
    return KEY_FORMATS.reduce((value, pattern) => value.replace(pattern, REDACTED), masked)
  }
  const redactLine = (text: string): string => {
    // 先解码 JSON 中的转义，再遮盖字符串，避免引号密钥破坏 JSON 或 Unicode 转义绕过脱敏。
    try {
      const value: unknown = JSON.parse(text)
      if (value === null || typeof value !== 'object' && typeof value !== 'string') return mask(text)
      const safe = redactValue(value, mask)
      if (JSON.stringify(safe) !== JSON.stringify(value)) return JSON.stringify(safe)
      return text
    } catch {
      return mask(text)
    }
  }
  return text => {
    // stdout 可能是多行 JSONL；逐行保留 JSON 结构，也保留原有 CRLF 与末行无换行状态。
    return text.replace(/[^\r\n]+/g, redactLine)
  }
}

export function redactValue<T>(input: T, redact: (text: string) => string): T {
  if (typeof input === 'string') return redact(input) as T
  if (typeof input === 'number' || typeof input === 'boolean') {
    return (redact(String(input)) === String(input) ? input : REDACTED) as T
  }
  if (Array.isArray(input)) return input.map((value) => redactValue(value, redact)) as T
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [redact(key), redactValue(value, redact)])) as T
  }
  return input
}
