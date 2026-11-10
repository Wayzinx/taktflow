import { collectSecrets, createRedactor, providerProtocols, resolveSecret, type CatalogList, type HarnessAdapter, type HarnessInfo, type ProjectStores, type RuntimeCatalog } from '@taktflow/core'
import { createHarnesses, harnessCatalogInfo, harnessCommand, providerConfig } from '@taktflow/harness'
import { providerBrands, type CatalogCallbacks } from './catalog.js'
import type { RuntimeCallbacks } from './runtime-routes.js'
import type { M3Callbacks } from './m3-routes.js'
import { ModelCatalog, type ProviderModels } from './model-catalog.js'
import type { ModelsDevData } from './model-metadata.js'
import { pairingMatrix } from './pairings.js'
import { HttpError } from './http.js'

type Options = CatalogCallbacks & RuntimeCallbacks & M3Callbacks
const waiting = (): CatalogList => ({ models: [], source: 'preset', error: '正在获取…' })

function registry(stores: ProjectStores) {
  return createHarnesses({ config: stores.config, projectDir: stores.projectDir, includeDisabled: true })
}

function harnessInfo(stores: ProjectStores, harness: HarnessAdapter): HarnessInfo {
  const config = stores.config
  const custom = config.harnesses?.find(h => h.id === harness.id)
  const hidden = config.harnessOverrides?.[harness.id]?.disabled === true
  return harnessCatalogInfo({ id: harness.id, displayName: harness.displayName, capabilities: harness.capabilities ?? {},
    source: harness.id === 'native' ? 'native' : custom?.kind ?? 'builtin', custom: !!custom,
    available: false, reason: hidden ? '本空间已停用' : '正在检测…', command: harnessCommand(harness),
    roles: Object.entries(config.roles ?? {}).filter(([, selector]) => selector.harness === harness.id).map(([role]) => role) }, config)
}

export function createRuntimeModelCatalog(options: Options) {
  const spaces = new Map<string, ModelCatalog>()
  const catalogFor = (stores: ProjectStores) => {
    let catalog = spaces.get(stores.taktDir)
    if (!catalog) { catalog = new ModelCatalog(stores.taktDir, options.catalogFetch); spaces.set(stores.taktDir, catalog) }
    return catalog
  }
  const adapters = async (stores: ProjectStores) => {
    const runtime = await options.resolveRuntime?.(stores)
    if (!runtime) return registry(stores)
    const result = { ...runtime.harnesses }
    const all = registry(stores)
    for (const [id, override] of Object.entries(stores.config.harnessOverrides ?? {})) if (override.disabled && all[id]) result[id] = all[id]!
    return result
  }

  async function get(stores: ProjectStores, includeTest = false): Promise<RuntimeCatalog> {
    const config = stores.config
    const catalog = catalogFor(stores)
    const redact = createRedactor(collectSecrets(undefined, config.providers))
    const fallback = registry(stores)
    let infos = Object.values(fallback).map(h => harnessInfo(stores, h))
    const owns = new Map<string, CatalogList>(Object.values(fallback).filter(h => h.listModels).map(h => [h.id, waiting()]))
    const providers = new Map<string, ProviderModels>()
    let metadata: ModelsDevData | undefined
    const work: Promise<unknown>[] = [catalog.metadata().then(result => { metadata = result.value })]
    for (const id of Object.keys(config.providers ?? {})) {
      const provider = providerConfig(id, config.providers![id]!)
      const missing = provider.apiKeyEnv && !resolveSecret(provider.apiKeyEnv)
      providers.set(id, catalog.fallback(config, id, missing ? `缺少密钥 ${provider.apiKeyEnv}` : '正在获取…'))
      work.push(catalog.provider(config, id).then(result => { providers.set(id, result) }))
    }
    work.push(adapters(stores).then(async adapters => {
      for (const harness of Object.values(adapters)) if (harness.listModels && !owns.has(harness.id)) owns.set(harness.id, waiting())
      const lists = Object.values(adapters).filter(h => h.listModels).map(async h => { owns.set(h.id, await catalog.harness(config, h)) })
      const info = async () => {
        if (options.getHarnesses) return options.getHarnesses(stores, includeTest)
        if (options.getCatalog) return (await options.getCatalog(stores, includeTest)).harnesses
        infos = Object.values(adapters).map(h => harnessInfo(stores, h))
        await Promise.all(infos.map(async row => {
          if (row.hidden) return
          try {
            const result = await adapters[row.id]!.available()
            Object.assign(row, { available: result.ok, reason: result.reason, ownReady: result.ownReady, ownReason: result.ownReason })
          } catch (error) { row.reason = redact(error instanceof Error ? error.message : 'Harness 探测失败') }
        }))
        return infos
      }
      await Promise.all([...lists, info().then(rows => { infos = rows.map(row => harnessCatalogInfo(row, config)) })])
    }).catch(error => {
      const message = redact(error instanceof Error ? error.message : '运行时加载失败')
      for (const [id, own] of owns) if (own.error === '正在获取…') owns.set(id, { models: [], source: 'preset', error: message })
    }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.allSettled(work), new Promise<void>(resolve => { timer = setTimeout(resolve, 2_800) })])
    } finally { clearTimeout(timer) }
    const harnesses = infos.filter(h => includeTest || !h.testOnly).map(h => ({ ...h,
      accepts: h.capabilities.customProvider ? h.capabilities.providerProtocols ?? [] : [], ...(owns.has(h.id) ? { own: owns.get(h.id)! } : {}) }))
    const result: RuntimeCatalog = { harnesses, providers: [...providers].map(([id, result]) => {
      const provider = providerConfig(id, config.providers![id]!)
      return { id, displayName: providerBrands[provider.preset ?? id] ?? id, protocols: providerProtocols(provider), keyPresent: !provider.apiKeyEnv || !!resolveSecret(provider.apiKeyEnv),
        ...catalog.enrich(config, id, result, metadata) }
    }), pairings: pairingMatrix(config, harnesses, options.bridge), enrichment: metadata ? 'ok' : 'unavailable' }
    return JSON.parse(redact(JSON.stringify(result))) as RuntimeCatalog
  }

  async function refresh(stores: ProjectStores, target: unknown): Promise<CatalogList> {
    if (!target || typeof target !== 'object' || !('kind' in target) || !('id' in target) || typeof target.id !== 'string') throw new HttpError(400, 'target 必须包含 kind 和 id')
    const catalog = catalogFor(stores)
    if (target.kind === 'provider') {
      if (!Object.hasOwn(stores.config.providers ?? {}, target.id)) throw new HttpError(404, 'provider 不存在')
      const [result, metadata] = await Promise.all([catalog.provider(stores.config, target.id, true), catalog.metadata()])
      const redact = createRedactor(collectSecrets(undefined, stores.config.providers))
      return JSON.parse(redact(JSON.stringify(catalog.enrich(stores.config, target.id, result, metadata.value).models))) as CatalogList
    }
    if (target.kind === 'harness') {
      const registry = await adapters(stores)
      if (!Object.hasOwn(registry, target.id)) throw new HttpError(404, 'harness 不存在')
      const harness = registry[target.id]!
      return catalog.harness(stores.config, harness, true)
    }
    throw new HttpError(400, 'target.kind 必须是 provider 或 harness')
  }
  return { get, refresh }
}
