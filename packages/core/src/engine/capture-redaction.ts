import type { HarnessRequest, ProviderConfig } from '../types.js'

interface RedactionModule {
  collectSecrets(request?: HarnessRequest, providers?: Record<string, ProviderConfig>): string[]
  createRedactor(secrets: readonly string[]): (text: string) => string
}
let module: Promise<RedactionModule> | undefined
export async function captureRedactor(request: HarnessRequest, providers?: Record<string, ProviderConfig>) {
  // 与实际适配器共享脱敏规则；延迟加载避免 core / harness 初始化循环。
  const name = '@taktflow/harness'
  const { collectSecrets, createRedactor } = await (module ??= import(name) as Promise<RedactionModule>)
  const redact = createRedactor(collectSecrets(request, providers))
  let redactions = 0
  const text = (value: string): string => {
    const safe = redact(value)
    if (safe !== value) redactions += Math.max(1, (safe.match(/\[REDACTED\]/g)?.length ?? 0) - (value.match(/\[REDACTED\]/g)?.length ?? 0))
    return safe
  }
  return { text, get redactions() { return redactions }, value: <T>(value: T): T => JSON.parse(text(JSON.stringify(value))) as T }
}
