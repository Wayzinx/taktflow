import { join } from 'node:path'
import type { NodeContext, TaktConfig } from '../types.js'
import { readJsonFile } from '../store/fs-utils.js'

export type EnvironmentConfig = NonNullable<TaktConfig['environment']>
const configurations = new WeakMap<NodeContext, TaktConfig['environment']>()

export function bindEnvironment(ctx: NodeContext, config: TaktConfig['environment']): void {
  configurations.set(ctx, config)
}

export function validateEnvironment(value: unknown): asserts value is TaktConfig['environment'] {
  if (value === undefined) return
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  if (!object(value) || !text(value.deploy)) throw new Error('environment.deploy 必须是非空命令')
  for (const key of ['setup', 'teardown']) if (value[key] !== undefined && !text(value[key])) throw new Error(`environment.${key} 必须是非空命令`)
  const health = value.healthcheck
  if (health !== undefined) {
    if (!object(health) || Number(health.command !== undefined) + Number(health.url !== undefined) !== 1
      || !text(health.command ?? health.url)) throw new Error('environment.healthcheck 必须配置 command 或 url 其中之一')
    if (health.timeoutMs !== undefined && (typeof health.timeoutMs !== 'number' || !Number.isSafeInteger(health.timeoutMs) || health.timeoutMs <= 0)) {
      throw new Error('environment.healthcheck.timeoutMs 必须是正整数')
    }
    if (health.url !== undefined) {
      try { if (!['http:', 'https:'].includes(new URL(health.url as string).protocol)) throw new Error() }
      catch { throw new Error('environment.healthcheck.url 必须是 HTTP(S) URL') }
    }
  }
  if (value.env !== undefined && (!object(value.env) || Object.entries(value.env).some(([key, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof v !== 'string'))) {
    throw new Error('environment.env 必须是环境变量名到字符串的映射')
  }
}

export async function environmentConfig(ctx: NodeContext): Promise<TaktConfig['environment']> {
  if (configurations.has(ctx)) return configurations.get(ctx)
  const config = await readJsonFile<TaktConfig>(join(ctx.projectDir, 'takt.config.json'))
  validateEnvironment(config?.environment)
  return config?.environment
}

export interface EnvironmentCommandVariableResult {
  /** 用例命令实际拿到的值；缺失或不可解析时为空。 */
  value?: string
  /** 值来源：config.env（含 ${} 解析）或宿主进程环境（命令子进程会继承）。 */
  source?: 'environment.env' | 'host-process'
  error?: string
}

/**
 * 用例命令实际会拿到的单个环境变量值。
 *
 * 与 environmentVariables 相同的合并顺序：config.env（含 ${宿主变量} 解析）
 * 优先，其次是宿主进程环境（命令子进程会继承）；两者都没有时明确报告缺失，
 * 不猜测、不读取无关默认值。只解析单个变量，避免完整环境或凭据进入证据。
 */
export async function environmentCommandVariable(ctx: NodeContext, name: string): Promise<EnvironmentCommandVariableResult> {
  const config = await environmentConfig(ctx)
  const template = config?.env?.[name]
  if (template !== undefined) {
    const missing: string[] = []
    const value = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
      const host = process.env[key]
      if (host === undefined) {
        missing.push(key)
        return ''
      }
      return host
    })
    if (missing.length > 0) {
      return { source: 'environment.env', error: `environment.env.${name} 引用的宿主变量未设置：${missing.join(', ')}` }
    }
    return { value, source: 'environment.env' }
  }
  const inherited = process.env[name]
  if (inherited === undefined || inherited === '') return {}
  return { value: inherited, source: 'host-process' }
}

export function environmentVariables(config: TaktConfig['environment'], ctx: NodeContext) {
  const secrets = new Set<string>()
  const extra: Record<string, string> = {}
  for (const [key, template] of Object.entries(config?.env ?? {})) {
    secrets.add(template)
    extra[key] = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = process.env[name]
      if (value === undefined) throw new Error(`environment.env 引用的宿主变量未设置：${name}`)
      secrets.add(value)
      return value
    })
    secrets.add(extra[key]!)
  }
  // URL 的认证信息也不能进入证据或日志。
  if (config?.healthcheck?.url) {
    const url = new URL(config.healthcheck.url)
    for (const value of [url.username, url.password, ...url.searchParams.values()]) {
      secrets.add(value)
      try { secrets.add(decodeURIComponent(value)) } catch { /* 非法转义保留原值。 */ }
    }
  }
  const values = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
  const redact = (text: string) => values.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), text)
  return {
    env: { ...extra, ...(config?.healthcheck?.url ? { TAKT_ENV_URL: config.healthcheck.url } : {}),
      TAKT_RUN_ID: ctx.runId, TAKT_REQ: ctx.requirementId, TAKT_WORKSPACE: ctx.workspaceDir, TAKT_NODE: ctx.nodeId,
      TAKT_ENV_ROUND: String(ctx.iteration ?? 1) },
    redact, redactionOverlap: values[0]?.length ?? 0,
  }
}
