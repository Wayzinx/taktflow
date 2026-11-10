import type { StewardRuntime } from '../api.js'
import { StewardError, type StewardDeps } from './contracts.js'
import type { StewardStore } from './store.js'

export async function validateStewardRuntime(runtime: unknown, deps: StewardDeps, store: StewardStore): Promise<void> {
  if (runtime === undefined || runtime === null) return
  if (typeof runtime !== 'object' || Array.isArray(runtime) || Object.keys(runtime).some(key => !['harness', 'model', 'provider', 'effort'].includes(key)) ||
    'harness' in runtime && runtime.harness !== undefined && typeof runtime.harness !== 'string' ||
    'model' in runtime && runtime.model !== undefined && typeof runtime.model !== 'string' ||
    'provider' in runtime && runtime.provider !== undefined && (typeof runtime.provider !== 'string' || !runtime.provider.trim()) ||
    'effort' in runtime && runtime.effort !== undefined && (typeof runtime.effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(runtime.effort)))
    throw new StewardError(400, '运行配置格式错误，请重新选择 harness 和模型')
  const value = runtime as StewardRuntime
  const prefs = await store.prefs()
  const choices = await deps.runtimeChoices?.(prefs) ?? []
  const choice = !value.provider && choices.find(choice => choice.harness === (value.harness ?? 'native') && choice.model === value.model)
  // 旧 choices 的可用性仍然有效；新 provider / 原始模型交给统一 selector 解析。
  if (choice) {
    if (!choice.available) throw new StewardError(400, choice.reason ?? '这个 harness 与模型组合不可用')
    return
  }
  if (deps.resolveRuntime) { await deps.resolveRuntime(prefs, value); return }
  throw new StewardError(400, '这个 harness 与模型组合不存在，请重新选择')
}
