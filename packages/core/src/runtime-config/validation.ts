import type { TaktConfig } from '../types.js'
import { SECRET_NAME } from '../secrets/index.js'

export interface RuntimeValidationOptions {
  builtinHarnesses: string[]
  pluginHarnesses?: string[]
  protocols?: string[]
  acpPresets: string[]
  providerPresets?: string[]
}
export class RuntimeConfigError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message) }
}
export function invalid(field: string, message: string): never {
  throw new RuntimeConfigError(400, `${field}：${message}；请修改该字段后重试`)
}
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function string(value: unknown): value is string { return typeof value === 'string' && !!value.trim() }
function strings(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.every(string) }
function map(value: unknown, field: string): void {
  if (!object(value) || Object.values(value).some(v => typeof v !== 'string')) invalid(field, '必须是字符串映射')
}
export function fields(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${field}.${key}`, '不支持此字段')
}

export function validateRuntimeConfig(config: TaktConfig, options: RuntimeValidationOptions): void {
  const protocols = new Set(['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini', 'bedrock', 'vertex', ...options.protocols ?? []])
  for (const [id, p] of Object.entries(config.providers ?? {})) {
    const path = `providers.${id}`
    if (!object(p)) invalid(path, '必须是对象')
    fields(p, ['protocol', 'baseURL', 'apiKeyEnv', 'headers', 'preset'], path)
    if (!protocols.has(p.protocol)) invalid(`${path}.protocol`, '协议不合法或尚未安装对应插件')
    if (p.apiKeyEnv !== undefined && (typeof p.apiKeyEnv !== 'string' || !SECRET_NAME.test(p.apiKeyEnv))) invalid(`${path}.apiKeyEnv`, '请填写大写环境变量名，密钥请存本机密钥库')
    if (p.preset !== undefined && !options.providerPresets?.includes(p.preset)) invalid(`${path}.preset`, '预设不存在')
    if (p.headers !== undefined) map(p.headers, `${path}.headers`)
    if (p.baseURL !== undefined) {
      let url: URL
      try { url = new URL(p.baseURL) } catch { invalid(`${path}.baseURL`, '需要 HTTP(S) 地址') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid(`${path}.baseURL`, '地址不能含凭据或 fragment')
    }
  }
  for (const [id, m] of Object.entries(config.models ?? {})) {
    const path = `models.${id}`
    if (!object(m)) invalid(path, '必须是对象')
    fields(m, ['provider', 'id', 'kind', 'dimensions', 'contextWindow', 'price'], path)
    if (!string(m.provider) || !Object.hasOwn(config.providers ?? {}, m.provider)) invalid(`${path}.provider`, '指向不存在的 provider，请先登记 provider')
    if (!string(m.id)) invalid(`${path}.id`, '缺少厂商模型 ID')
    if (m.kind !== undefined && !['chat', 'embedding'].includes(m.kind)) invalid(`${path}.kind`, '只支持 chat 或 embedding')
    for (const key of ['dimensions', 'contextWindow'] as const) if (m[key] !== undefined && (!Number.isSafeInteger(m[key]) || m[key]! <= 0)) invalid(`${path}.${key}`, '必须是正整数')
    if (m.kind === 'embedding' && m.dimensions === undefined) invalid(`${path}.dimensions`, '向量模型需要维度')
    if (m.price !== undefined && (!object(m.price) || [m.price.input, m.price.output, m.price.cachedInput ?? 0].some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0))) invalid(`${path}.price`, '价格必须是非负有限数值，并包含 input/output')
  }
  const ids = new Set([...options.builtinHarnesses, ...options.pluginHarnesses ?? []])
  for (const h of config.harnesses ?? []) {
    const path = `harnesses.${h.id}`
    if (!object(h) || !string(h.id) || ids.has(h.id)) invalid(path, 'ID 重复、与内置/插件冲突或为空')
    ids.add(h.id)
    if (h.kind !== 'cli' && h.kind !== 'acp') invalid(`${path}.kind`, '只支持 cli 或 acp')
    fields(h, h.kind === 'acp' ? ['id', 'kind', 'displayName', 'preset', 'command', 'env', 'permissions']
      : ['id', 'kind', 'displayName', 'command', 'env', 'promptVia', 'model', 'resume', 'output', 'available', 'capabilities'], path)
    if (h.command !== undefined && !strings(h.command)) invalid(`${path}.command`, '必须是非空命令数组')
    if (h.displayName !== undefined && !string(h.displayName)) invalid(`${path}.displayName`, '必须是非空字符串')
    if (h.env !== undefined) map(h.env, `${path}.env`)
    if (h.kind === 'acp') {
      if (!h.command && !options.acpPresets.includes(h.preset ?? '')) invalid(path, 'ACP 需要有效 preset 或 command')
      if (h.preset !== undefined && !options.acpPresets.includes(h.preset)) invalid(`${path}.preset`, 'ACP 预设不存在')
      if (h.permissions !== undefined && !['allow', 'reject'].includes(h.permissions)) invalid(`${path}.permissions`, '只能是 allow 或 reject')
    } else {
      if (!strings(h.command)) invalid(`${path}.command`, 'CLI 需要启动命令')
      if (!object(h.output) || !['text', 'jsonl'].includes(h.output.format)) invalid(`${path}.output`, '需要 text 或 jsonl 输出格式')
      if (h.promptVia !== undefined && !['stdin', 'arg', 'file'].includes(h.promptVia)) invalid(`${path}.promptVia`, '只能是 stdin、arg 或 file')
      if (h.available !== undefined && !strings(h.available)) invalid(`${path}.available`, '需要命令数组')
      if (h.model !== undefined && (!object(h.model) || Object.values(h.model).some(v => !string(v)))) invalid(`${path}.model`, 'flag/env 必须是非空字符串')
      if (h.resume !== undefined && (!object(h.resume) || !strings(h.resume.args))) invalid(`${path}.resume`, '需要非空 args 命令数组')
      if (h.output.events !== undefined) {
        if (!object(h.output.events)) invalid(`${path}.output.events`, '需要字段映射对象')
        for (const [key, value] of Object.entries(h.output.events)) {
          if (key === 'final') {
            if (!object(value) || !string(value.field) || typeof value.equals !== 'string') invalid(`${path}.output.events.final`, '需要 field 与 equals 字符串')
          } else if (!string(value)) invalid(`${path}.output.events.${key}`, '需要字段路径字符串')
        }
      }
      if (h.capabilities !== undefined) {
        if (!object(h.capabilities)) invalid(`${path}.capabilities`, '必须是能力对象')
        for (const [key, value] of Object.entries(h.capabilities)) {
          if (key === 'providerProtocols') { if (!strings(value)) invalid(`${path}.capabilities.${key}`, '需要协议数组') }
          else if (typeof value !== 'boolean') invalid(`${path}.capabilities.${key}`, '能力值必须是 boolean')
        }
      }
    }
  }
  for (const [id, override] of Object.entries(config.harnessOverrides ?? {})) {
    const path = `harnessOverrides.${id}`
    if (!options.builtinHarnesses.includes(id)) invalid(path, '只能覆盖内置 harness')
    if (!object(override)) invalid(path, '必须是对象')
    fields(override, ['command', 'env', 'disabled'], path)
    if (override.disabled !== undefined && typeof override.disabled !== 'boolean') invalid(`${path}.disabled`, '必须是 boolean')
    if (override.command !== undefined && !string(override.command)) invalid(`${path}.command`, '需要可执行文件路径')
    if (override.env !== undefined) map(override.env, `${path}.env`)
  }
  const selector = (s: unknown, path: string, depth = 0): void => {
    if (!object(s) || !string(s.harness)) invalid(path, '需要 harness')
    if (depth > 20) invalid(path, 'fallback 嵌套过深')
    fields(s, ['harness', 'model', 'provider', 'effort', 'fallback'], path)
    if (!ids.has(s.harness) || config.harnessOverrides?.[s.harness]?.disabled) invalid(`${path}.harness`, 'harness 不存在或本空间已停用')
    if (s.model !== undefined && !string(s.model)) invalid(`${path}.model`, '需要模型别名或厂商模型名')
    if (s.provider !== undefined && (!string(s.provider) || !Object.hasOwn(config.providers ?? {}, s.provider))) invalid(`${path}.provider`, 'provider 不存在')
    if (s.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(s.effort as string)) invalid(`${path}.effort`, '推理强度不合法')
    if (s.fallback !== undefined) {
      if (!Array.isArray(s.fallback)) invalid(`${path}.fallback`, '必须是数组')
      s.fallback.forEach((v, i) => selector(v, `${path}.fallback.${i}`, depth + 1))
    }
  }
  for (const [id, value] of Object.entries(config.roles ?? {})) selector(value, `roles.${id}`)
  for (const [id, value] of Object.entries({ lead: config.lead?.harness, route: config.route?.harness, steward: config.steward?.harness, learner: config.lessons?.learner })) {
    if (value !== undefined) selector(value, `system.${id}`)
  }
}
