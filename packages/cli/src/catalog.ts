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

export async function runtimeHarnesses(context: ProjectContext, onProbeError?: () => void): Promise<HarnessInfo[]> {
  const { config } = context.stores
  const roles = { ...config.roles }
  for (const [role, profile] of Object.entries(context.profiles)) roles[role] = profile.harness
  const harnesses = await Promise.all(Object.entries(context.harnesses).map(async ([id, harness]): Promise<HarnessInfo> => {
    let availability: { ok: boolean; reason?: string }
    try { availability = await harness.available() }
    catch (error) { onProbeError?.(); availability = { ok: false, reason: error instanceof Error ? error.message : String(error) } }
    return {
      id, displayName: harness.displayName,
      source: Object.hasOwn(context.plugins.harnesses, id) ? 'plugin' : id === 'native' ? 'native' : config.harnesses?.some((item) => item.id === id) ? 'cli' : 'builtin',
      available: availability.ok,
      ...(availability.reason ? { reason: redactRuntime(context, availability.reason) } : {}),
      capabilities: harness.capabilities ?? {},
      roles: Object.entries(roles).filter(([, selector]) => selector.harness === id).map(([role]) => role).sort(),
    }
  }))
  return harnesses
}

export function runtimeModels(context: ProjectContext): ModelInfo[] {
  const { config } = context.stores
  return Object.entries(config.models ?? {}).map(([alias, model]): ModelInfo => {
    const provider = config.providers![model.provider]!
    return {
      alias, id: model.id, provider: model.provider, protocol: provider.protocol,
      contextWindow: model.contextWindow,
      price: model.price ? { input: model.price.input, output: model.price.output } : undefined,
      keyPresent: !provider.apiKeyEnv || !!process.env[provider.apiKeyEnv]?.trim(),
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
  const ttl = 30_000
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
        validate(context)
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

  async function getHarnesses(stores: ProjectStores): Promise<HarnessInfo[]> {
    const context = await runtime(stores)
    const cached = probes.get(context)
    if (cached && now() < cached.expires) return cached.promise
    let failed = false
    const entry: CacheEntry<HarnessInfo[]> = {
      expires: Infinity,
      promise: runtimeHarnesses(context, () => { failed = true }).then((rows) => {
        // 不可用是合法探测结果；探测抛错则保留本次原因，下次请求立即重试。
        entry.expires = failed ? 0 : now() + ttl
        return rows
      }).catch((error: unknown) => {
        if (probes.get(context) === entry) probes.delete(context)
        throw error
      }),
    }
    probes.set(context, entry)
    return entry.promise
  }

  async function getModels(stores: ProjectStores): Promise<ModelInfo[]> {
    return runtimeModels(await runtime(stores))
  }

  async function getCatalog(stores: ProjectStores): Promise<RuntimeCatalog> {
    const [harnesses, models] = await Promise.all([getHarnesses(stores), getModels(stores)])
    return { harnesses, models }
  }

  return { getHarnesses, getModels, getCatalog }
}

export const getRuntimeCatalog = createRuntimeCatalog().getCatalog
