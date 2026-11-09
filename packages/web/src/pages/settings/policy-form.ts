import type { Autonomy, SpaceConfigPatch, SpaceConfigSettings, SpaceSettings } from '@taktflow/core'

/** 运行策略表单的纯数据层：把设置转成表单、校验、再转回 patch。和 React 无关，便于单测。 */

export interface EnvForm {
  enabled: boolean
  setup: string
  deploy: string
  healthKind: 'none' | 'url' | 'command'
  health: string
  healthTimeoutSec: string
  teardown: string
  env: Array<[string, string]>
  testCommand: string
}

export interface Form {
  defaultWorkflow: string
  autonomy: Autonomy
  env: EnvForm
  selftestTimeoutMin: string
  allowedCommands: string[]
  budgetTokens: string
  budgetMinutes: string
  budgetCost: string
}

export interface FormErrors {
  deploy?: string
  health?: string
  healthTimeout?: string
  env?: string[]
  selftestTimeout?: string
  budgetTokens?: string
  budgetMinutes?: string
  budgetCost?: string
}

export interface ParsedValues {
  healthTimeoutMs?: number
  selftestTimeoutMs?: number
  budgetTokens?: number
  budgetMinutes?: number
  budgetCost?: number
  env?: Record<string, string>
}

export interface Validation {
  errors: FormErrors
  values: ParsedValues
  invalidEnvRows: Set<number>
}

export function toForm(c: SpaceConfigSettings, settings: SpaceSettings): Form {
  const e = c.environment
  const health = e?.healthcheck
  return {
    defaultWorkflow: c.defaultWorkflow ?? settings.workflows.find((w) => w.default)?.id ?? '',
    autonomy: c.autonomy ?? 'full',
    env: {
      enabled: !!e,
      setup: e?.setup ?? '',
      deploy: e?.deploy ?? '',
      healthKind: health?.url ? 'url' : health?.command ? 'command' : 'none',
      health: health?.url ?? health?.command ?? '',
      healthTimeoutSec: health?.timeoutMs ? String(Math.round(health.timeoutMs / 1000)) : '',
      teardown: e?.teardown ?? '',
      env: Object.entries(e?.env ?? {}),
      testCommand: e?.testCommand ?? '',
    },
    selftestTimeoutMin: c.selftest?.timeoutMs ? String(c.selftest.timeoutMs / 60000) : '',
    allowedCommands: [...(c.selftest?.allowedCommands ?? [])],
    budgetTokens: c.budget?.tokens ? String(c.budget.tokens) : '',
    budgetMinutes: c.budget?.minutes ? String(c.budget.minutes) : '',
    budgetCost: c.budget?.costUsd ? String(c.budget.costUsd) : '',
  }
}

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/

/** 只接受正数；空串表示“不设置”。不使用输入框字符过滤，避免把 -1 静默改成 1。 */
function positive(raw: string, label: string, integer = false): { value?: number; error?: string } {
  const text = raw.trim()
  if (text === '') return {}
  if (!NUMBER.test(text)) return { error: `${label}要填正数，例如 5` }
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return { error: `${label}要大于 0` }
  if (integer && !Number.isSafeInteger(value)) return { error: `${label}要填整数` }
  return { value }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateForm(f: Form): Validation {
  const errors: FormErrors = {}
  const values: ParsedValues = {}
  const invalidEnvRows = new Set<number>()

  if (f.env.enabled) {
    if (!f.env.deploy.trim()) errors.deploy = '开启环境部署时，部署 / 启动命令必填'
    if (f.env.healthKind !== 'none') {
      const health = f.env.health.trim()
      if (!health) errors.health = f.env.healthKind === 'url' ? '请填写探活 URL' : '请填写探活命令'
      else if (f.env.healthKind === 'url' && !isHttpUrl(health)) errors.health = '探活 URL 必须是 http:// 或 https:// 开头的完整地址'

      const timeout = positive(f.env.healthTimeoutSec, '探活超时（秒）', true)
      if (timeout.error) errors.healthTimeout = timeout.error
      else if (timeout.value !== undefined) {
        const ms = timeout.value * 1000
        if (!Number.isSafeInteger(ms)) errors.healthTimeout = '探活超时太大了'
        else values.healthTimeoutMs = ms
      }
    }

    const env: Record<string, string> = {}
    const seen = new Map<string, number>()
    const issues: string[] = []
    f.env.env.forEach(([rawKey, value], index) => {
      const key = rawKey.trim()
      if (!key && !value.trim()) return
      const row = index + 1
      if (!key) {
        issues.push(`第 ${row} 行：变量名不能为空`)
        invalidEnvRows.add(index)
        return
      }
      if (!ENV_NAME.test(key)) {
        issues.push(`变量名 ${key} 不合法：只能用字母、数字、下划线，且不能以数字开头`)
        invalidEnvRows.add(index)
        return
      }
      const first = seen.get(key)
      if (first !== undefined) {
        issues.push(`变量名 ${key} 重复（第 ${first} 行和第 ${row} 行）`)
        invalidEnvRows.add(index)
        return
      }
      seen.set(key, row)
      env[key] = value
    })
    if (issues.length) errors.env = issues
    else if (Object.keys(env).length) values.env = env
  }

  const selftest = positive(f.selftestTimeoutMin, '自测超时（分钟）')
  if (selftest.error) errors.selftestTimeout = selftest.error
  else if (selftest.value !== undefined) {
    const ms = Math.round(selftest.value * 60000)
    if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 3_600_000) errors.selftestTimeout = '自测超时换算后要在 1 秒到 60 分钟之间'
    else values.selftestTimeoutMs = ms
  }

  const tokens = positive(f.budgetTokens, 'Token 上限')
  if (tokens.error) errors.budgetTokens = tokens.error
  else if (tokens.value !== undefined) values.budgetTokens = tokens.value

  const minutes = positive(f.budgetMinutes, '时长上限（分钟）')
  if (minutes.error) errors.budgetMinutes = minutes.error
  else if (minutes.value !== undefined) values.budgetMinutes = minutes.value

  const cost = positive(f.budgetCost, '成本上限（美元）')
  if (cost.error) errors.budgetCost = cost.error
  else if (cost.value !== undefined) values.budgetCost = cost.value

  return { errors, values, invalidEnvRows }
}

export function hasErrors(validation: Validation): boolean {
  return Object.keys(validation.errors).length > 0
}

export function toPatch(f: Form, original: Form, values: ParsedValues): SpaceConfigPatch {
  const patch: SpaceConfigPatch = {}
  const changed = <K extends keyof Form>(k: K) => JSON.stringify(f[k]) !== JSON.stringify(original[k])
  if (changed('defaultWorkflow') && f.defaultWorkflow) patch.defaultWorkflow = f.defaultWorkflow
  if (changed('autonomy')) patch.autonomy = f.autonomy
  if (changed('env')) {
    const e = f.env
    if (!e.enabled) patch.environment = null
    else {
      const healthcheck = e.healthKind === 'url'
        ? { url: e.health.trim(), ...(values.healthTimeoutMs !== undefined ? { timeoutMs: values.healthTimeoutMs } : {}) }
        : e.healthKind === 'command'
          ? { command: e.health.trim(), ...(values.healthTimeoutMs !== undefined ? { timeoutMs: values.healthTimeoutMs } : {}) }
          : undefined
      patch.environment = {
        deploy: e.deploy.trim(),
        ...(e.setup.trim() ? { setup: e.setup.trim() } : {}),
        ...(e.teardown.trim() ? { teardown: e.teardown.trim() } : {}),
        ...(healthcheck ? { healthcheck } : {}),
        ...(values.env && Object.keys(values.env).length ? { env: values.env } : {}),
        ...(e.testCommand.trim() ? { testCommand: e.testCommand.trim() } : {}),
      }
    }
  }
  if (changed('selftestTimeoutMin') || changed('allowedCommands')) {
    const selftest = {
      ...(values.selftestTimeoutMs !== undefined ? { timeoutMs: values.selftestTimeoutMs } : {}),
      ...(f.allowedCommands.length ? { allowedCommands: f.allowedCommands } : {}),
    }
    patch.selftest = Object.keys(selftest).length ? selftest : null
  }
  if (changed('budgetTokens') || changed('budgetMinutes') || changed('budgetCost')) {
    const budget = {
      ...(values.budgetTokens !== undefined ? { tokens: values.budgetTokens } : {}),
      ...(values.budgetMinutes !== undefined ? { minutes: values.budgetMinutes } : {}),
      ...(values.budgetCost !== undefined ? { costUsd: values.budgetCost } : {}),
    }
    patch.budget = Object.keys(budget).length ? budget : null
  }
  return patch
}
