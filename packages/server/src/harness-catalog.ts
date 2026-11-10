import { canonicalJson, collectSecrets, createRedactor, selectHarness, sha256, type HarnessAdapter, type HarnessInfo, type ProjectStores } from '@taktflow/core'
import { createHarnesses, harnessCatalogInfo, harnessCommand } from '@taktflow/harness'
import type { CatalogCallbacks } from './catalog.js'
import type { M3Callbacks } from './m3-routes.js'
import { harnessAvailability, harnessAvailabilityRevision, knownHarnessAvailability, ProbeCache } from './harness-availability.js'

type Options = CatalogCallbacks & M3Callbacks
const legacy = new WeakMap<Options, ProbeCache<HarnessInfo[]>>()
type LegacyCatalog = Awaited<ReturnType<NonNullable<CatalogCallbacks['getCatalog']>>>
const legacyCatalogs = new WeakMap<Options, ProbeCache<LegacyCatalog>>()

function legacyKey(stores: ProjectStores) {
  return sha256(canonicalJson([stores.projectDir, stores.config, harnessAvailabilityRevision(stores.projectDir)]))
}

export function legacyCatalog(stores: ProjectStores, options: Options) {
  let cache = legacyCatalogs.get(options)
  if (!cache) { cache = new ProbeCache(); legacyCatalogs.set(options, cache) }
  return cache.get(legacyKey(stores), () => options.getCatalog!(stores, true))
}

export function harnessInfo(stores: ProjectStores, harness: HarnessAdapter): HarnessInfo {
  const config = stores.config
  const custom = config.harnesses?.find(h => h.id === harness.id)
  const override = config.harnessOverrides?.[harness.id]
  const hidden = override?.disabled === true
  return harnessCatalogInfo({ id: harness.id, displayName: harness.displayName, capabilities: harness.capabilities ?? {},
    source: harness.id === 'native' ? 'native' : custom?.kind ?? (harnessCommand(harness) || harness.id === 'mock' ? 'builtin' : 'plugin'), custom: !!custom,
    available: false, reason: hidden ? '本空间已停用' : '正在检测…', command: harnessCommand(harness),
    ...(override ? { override: { ...override, ...(override.env ? { env: Object.fromEntries(Object.keys(override.env).map(name => [name, '[REDACTED]'])) } : {}) } } : {}),
    roles: Object.entries(config.roles ?? {}).filter(([, selector]) => selector.harness === harness.id).map(([role]) => role) }, config)
}

export async function catalogAdapters(stores: ProjectStores, options: Options) {
  const runtime = await options.resolveRuntime?.(stores)
  const all = createHarnesses({ config: stores.config, projectDir: stores.projectDir, includeDisabled: true })
  if (!runtime) return { adapters: all, profiles: {} }
  const adapters = { ...runtime.harnesses }
  for (const [id, override] of Object.entries(stores.config.harnessOverrides ?? {})) if (override.disabled && all[id]) adapters[id] = all[id]!
  return { adapters, profiles: runtime.profiles }
}

export async function catalogHarnesses(stores: ProjectStores, options: Options,
  resolved?: Awaited<ReturnType<typeof catalogAdapters>>, onRows?: (rows: HarnessInfo[]) => void): Promise<HarnessInfo[]> {
  // 旧接入只提供完整目录，无法取到适配器；按配置缓存回调，保留插件元数据。
  if (!options.resolveRuntime && (options.getHarnesses || options.getCatalog)) {
    let cache = legacy.get(options)
    if (!cache) { cache = new ProbeCache(); legacy.set(options, cache) }
    const rows = options.getHarnesses
      ? await cache.get(legacyKey(stores), () => options.getHarnesses!(stores, true))
      : (await legacyCatalog(stores, options)).harnesses
    const adapters = createHarnesses({ config: stores.config, projectDir: stores.projectDir, includeDisabled: true })
    return rows.map(row => {
      // 手工测试的新结果优先于兼容回调内部可能保留的旧快照。
      const adapter = adapters[row.id] ?? { ...row, available: async () => ({ ok: row.available }), run: async () => ({ ok: false, finalText: '' }) }
      const result = knownHarnessAvailability(stores.config, stores.projectDir, adapter)
      return result ? { ...row, available: result.ok, reason: result.reason, ownReady: result.ownReady, ownReason: result.ownReason } : row
    })
  }
  // 已有适配器时直接复用探测缓存；旧目录回调也会探测，不能再调用一遍。
  const { adapters, profiles } = resolved ?? await catalogAdapters(stores, options)
  const roles = { ...stores.config.roles }
  for (const role of Object.keys(profiles)) roles[role] = selectHarness(role, undefined, { config: stores.config, profiles, harnesses: adapters })
  const rows = Object.values(adapters).map(harness => ({ ...harnessInfo(stores, harness),
    roles: Object.entries(roles).filter(([, selector]) => selector.harness === harness.id).map(([role]) => role).sort() }))
  onRows?.(rows)
  await Promise.all(rows.map(async row => {
    if (row.hidden) return
    const result = await harnessAvailability(stores.config, stores.projectDir, adapters[row.id]!)
    Object.assign(row, { available: result.ok, reason: result.reason, ownReady: result.ownReady, ownReason: result.ownReason })
  }))
  const configs = [...Object.values(stores.config.harnessOverrides ?? {}), ...stores.config.harnesses ?? []]
  const redact = createRedactor([...collectSecrets(undefined, stores.config.providers),
    ...configs.flatMap(h => collectSecrets({ prompt: '', cwd: stores.projectDir, env: h.env }))])
  return JSON.parse(redact(JSON.stringify(rows))) as HarnessInfo[]
}
