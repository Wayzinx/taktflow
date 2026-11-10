import { providerProtocols, resolveSecret, selectHarness } from '@taktflow/core'
import { createHarnesses, harnessCommand, harnessCatalogInfo, collectSecrets, createRedactor } from '@taktflow/harness'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessInfo, ModelInfo, ProjectStores } from '@taktflow/core'
import { loadRuntime, type ProjectContext } from './project.js'
import { redactConfigError } from './runtime-config.js'
import { validateRuntime } from './runtime-validation.js'

export interface RuntimeCatalog { harnesses: HarnessInfo[]; models: ModelInfo[] }

export function redactRuntime(context: ProjectContext, message: string): string {
  return redactConfigError(context.stores.config, message)
}

function catalogHarnesses(context: ProjectContext) {
  const { config } = context.stores
  const registry = { ...context.harnesses }
  if (Object.values(config.harnessOverrides ?? {}).some(override => override.disabled)) {
    const all = createHarnesses({ config, projectDir: context.stores.projectDir, providers: context.providers, includeDisabled: true })
    for (const [id, override] of Object.entries(config.harnessOverrides ?? {})) if (override.disabled && all[id]) registry[id] = all[id]!
  }
  return registry
}

export async function runtimeHarnesses(context: ProjectContext, onProbeError?: () => void, includeTest = false): Promise<HarnessInfo[]> {
  const { config } = context.stores
  const roles = { ...config.roles }
  for (const role of Object.keys(context.profiles)) roles[role] = selectHarness(role, undefined, { ...context, config })
  const registry = catalogHarnesses(context)
  const harnesses = await Promise.all(Object.entries(registry).map(async ([id, harness]): Promise<HarnessInfo> => {
    let availability: { ok: boolean; reason?: string }
    try { availability = config.harnessOverrides?.[id]?.disabled ? { ok: false, reason: '本空间已停用' } : await harness.available() }
    catch (error) { onProbeError?.(); availability = { ok: false, reason: error instanceof Error ? error.message : String(error) } }
    const custom = config.harnesses?.find(item => item.id === id)
    const override = config.harnessOverrides?.[id]
    const redact = createRedactor(collectSecrets({ prompt: '', cwd: context.stores.projectDir, env: { ...custom?.env, ...override?.env } }))
    const command = harnessCommand(harness)
    return harnessCatalogInfo({
      id, displayName: redact(harness.displayName),
      source: Object.hasOwn(context.plugins.harnesses, id) ? 'plugin' : id === 'native' ? 'native' : custom?.kind ?? 'builtin',
      available: availability.ok,
      custom: !!custom,
      ...(command ? { command: command.map(redact) } : {}),
      ...(override ? { override: { ...override, ...(override.command ? { command: redact(override.command) } : {}),
        ...(override.env ? { env: Object.fromEntries(Object.keys(override.env).map(name => [name, '[REDACTED]'])) } : {}) } } : {}),
      ...(availability.reason ? { reason: redact(redactRuntime(context, availability.reason)) } : {}),
      capabilities: harness.capabilities ?? {},
      roles: Object.entries(roles).filter(([, selector]) => selector.harness === id).map(([role]) => role).sort(),
    }, config)
  }))
  return harnesses.filter(harness => includeTest || !harness.testOnly)
}

export function runtimeModels(context: ProjectContext): ModelInfo[] {
  const { config } = context.stores
  return Object.entries(config.models ?? {}).map(([alias, model]): ModelInfo => {
    const provider = config.providers![model.provider]!
    return {
      kind: model.kind ?? 'chat',
      alias, id: model.id, provider: model.provider, protocol: provider.protocol, protocols: providerProtocols(provider),
      contextWindow: model.contextWindow,
      price: model.price ? { input: model.price.input, output: model.price.output } : undefined,
      keyPresent: !provider.apiKeyEnv || !!resolveSecret(provider.apiKeyEnv),
    }
  })
}

export async function runtimeCatalog(context: ProjectContext): Promise<RuntimeCatalog> {
  return { harnesses: await runtimeHarnesses(context), models: runtimeModels(context) }
}

interface CacheEntry<T> { promise: Promise<T>; expires: number }
interface RuntimeEntry extends CacheEntry<ProjectContext> { mtime: number }

export function createRuntimeCatalog(options: {
  load?: typeof loadRuntime
  validate?: typeof validateRuntime
  now?: () => number
  mtime?: (projectDir: string) => Promise<number>
} = {}) {
  const load = options.load ?? loadRuntime
  const validate = options.validate ?? validateRuntime
  const now = options.now ?? Date.now
  const mtime = options.mtime ?? (async (dir: string) => (await stat(join(dir, 'takt.config.json'))).mtimeMs)
  const ttl = 60_000
  const runtimes = new Map<string, RuntimeEntry>()
  const probes = new WeakMap<ProjectContext, CacheEntry<HarnessInfo[]>>()

  async function runtime(stores: ProjectStores): Promise<ProjectContext> {
    const dir = stores.projectDir
    const modified = await mtime(dir)
    const cached = runtimes.get(dir)
    if (cached && cached.mtime === modified && now() < cached.expires) return cached.promise
    const entry: RuntimeEntry = {
      mtime: modified, expires: Infinity,
      promise: Promise.resolve().then(() => load(dir)).then((context) => {
        // 目录要能展示被停用的默认角色；执行注册表仍保持移除状态。
        validate({ ...context, harnesses: catalogHarnesses(context) })
        entry.expires = now() + ttl
        return context
      }).catch((error: unknown) => {
        if (runtimes.get(dir) === entry) runtimes.delete(dir)
        throw error
      }),
    }
    runtimes.set(dir, entry)
    return entry.promise
  }

  async function getHarnesses(stores: ProjectStores, includeTest = false): Promise<HarnessInfo[]> {
    const context = await runtime(stores)
    const cached = probes.get(context)
    if (cached && now() < cached.expires) return (await cached.promise).filter(h => includeTest || !h.testOnly)
    let failed = false
    const entry: CacheEntry<HarnessInfo[]> = {
      expires: Infinity,
      promise: runtimeHarnesses(context, () => { failed = true }, true).then((rows) => {
        // 不可用是合法探测结果；探测抛错则保留本次原因，下次请求立即重试。
        entry.expires = failed ? 0 : now() + ttl
        return rows
      }).catch((error: unknown) => {
        if (probes.get(context) === entry) probes.delete(context)
        throw error
      }),
    }
    probes.set(context, entry)
    return (await entry.promise).filter(h => includeTest || !h.testOnly)
  }

  async function getModels(stores: ProjectStores): Promise<ModelInfo[]> {
    return runtimeModels(await runtime(stores))
  }

  async function getCatalog(stores: ProjectStores, includeTest = false): Promise<RuntimeCatalog> {
    const [harnesses, models] = await Promise.all([getHarnesses(stores, includeTest), getModels(stores)])
    return { harnesses, models }
  }

  return { getHarnesses, getModels, getCatalog, invalidate: (projectDir: string) => { runtimes.delete(projectDir) } }
}

export const getRuntimeCatalog = createRuntimeCatalog().getCatalog
