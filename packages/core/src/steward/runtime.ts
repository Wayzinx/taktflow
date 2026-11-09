import type { StewardRuntime } from '../api.js'
import { StewardError, type StewardDeps } from './contracts.js'
import type { StewardStore } from './store.js'

export async function validateStewardRuntime(runtime: unknown, deps: StewardDeps, store: StewardStore): Promise<void> {
  if (runtime === undefined || runtime === null) return
  if (typeof runtime !== 'object' || Array.isArray(runtime) || Object.keys(runtime).some(key => !['harness', 'model'].includes(key)) ||
    'harness' in runtime && runtime.harness !== undefined && typeof runtime.harness !== 'string' ||
    'model' in runtime && runtime.model !== undefined && typeof runtime.model !== 'string')
    throw new StewardError(400, '运行配置格式错误，请重新选择 harness 和模型')
  const value = runtime as StewardRuntime
  const choices = await deps.runtimeChoices?.(await store.prefs()) ?? []
  const choice = choices.find(choice => choice.harness === (value.harness ?? 'native') && choice.model === value.model)
  if (!choice?.available) throw new StewardError(400, choice?.reason ?? '这个 harness 与模型组合不存在，请重新选择')
}
