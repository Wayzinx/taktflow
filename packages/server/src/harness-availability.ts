import { canonicalJson, sha256, type HarnessAdapter, type TaktConfig } from '@taktflow/core'
import { createHarnesses, harnessCommand } from '@taktflow/harness'

type Availability = Awaited<ReturnType<HarnessAdapter['available']>>
interface Entry<T> { value?: T; expires: number; pending?: Promise<T>; forced?: boolean }

export class ProbeCache<T> {
  private entries = new Map<string, Entry<T>>()
  constructor(private now = Date.now) {}

  get(key: string, probe: () => Promise<T>, force = false): Promise<T> {
    let entry = this.entries.get(key)
    // 手工测试不复用先前的自动探测；同时点测试则共用本轮新探测。
    if (!entry || (force && !entry.forced)) {
      entry = { expires: 0, forced: force }
      this.entries.set(key, entry)
    }
    if (!force && entry.value !== undefined && this.now() < entry.expires) return Promise.resolve(entry.value)
    if (!entry.pending) {
      const current = entry
      entry.pending = Promise.resolve().then(probe).then(value => {
        current.value = value
        current.expires = this.now() + 60_000
        return value
      }).finally(() => { current.pending = undefined; current.forced = false })
    }
    if (!force && entry.value !== undefined) {
      void entry.pending.catch(() => {})
      return Promise.resolve(entry.value)
    }
    return entry.pending
  }

  clear() { this.entries.clear() }
  peek(key: string) {
    const entry = this.entries.get(key)
    return entry && this.now() < entry.expires ? entry.value : undefined
  }
}

export function availabilityKey(config: TaktConfig | undefined, harness: HarnessAdapter): string {
  const custom = config?.harnesses?.find(item => item.id === harness.id)
  const override = config?.harnessOverrides?.[harness.id]
  return canonicalJson([harness.id, harnessCommand(harness), sha256(canonicalJson({
    env: { ...custom?.env, ...override?.env }, path: process.env.PATH, dshBin: process.env.DSH_BIN,
    custom, override, capabilities: harness.capabilities,
    // native 的探测依赖 provider，而不是启动命令。
    ...(harness.id === 'native' ? { providers: config?.providers, models: config?.models } : {}),
  }))])
}

const spaces = new Map<string, ProbeCache<Availability>>()
const revisions = new Map<string, number>()

export function harnessAvailabilityRevision(projectDir: string) { return revisions.get(projectDir) ?? 0 }
export function clearHarnessAvailability(projectDir: string) {
  spaces.get(projectDir)?.clear()
  revisions.set(projectDir, harnessAvailabilityRevision(projectDir) + 1)
}

export function knownHarnessAvailability(config: TaktConfig, projectDir: string, harness: HarnessAdapter) {
  return spaces.get(projectDir)?.peek(availabilityKey(config, harness))
}

export function harnessAvailability(config: TaktConfig | undefined, projectDir: string | undefined,
  harness: HarnessAdapter, force = false): Promise<Availability> {
  const scope = projectDir ?? process.cwd()
  let cache = spaces.get(scope)
  if (!cache) { cache = new ProbeCache(); spaces.set(scope, cache) }
  return cache.get(availabilityKey(config, harness), async () => {
    // 内置及声明式适配器可能还有对象级缓存；刷新时重建，不能把旧结果再续期。
    const command = harnessCommand(harness)
    const candidate = command ? createHarnesses({ config, projectDir, includeDisabled: true })[harness.id] : undefined
    const fresh = candidate && canonicalJson(harnessCommand(candidate) ?? null) === canonicalJson(command) ? candidate : undefined
    try { return await (fresh ?? harness).available() }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
  }, force)
}
