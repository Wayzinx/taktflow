import type { CatalogList, CatalogModel, RuntimeCatalog } from '@taktflow/core'
import { providerIconKey } from '../components/brand/brand-icon'
import { sameModel, type PickerGroup, type PickerHarness, type PickerModel, type PickerValue } from '../components/harness-picker/types'
import { harnessMeta, isTestOnly, readableReason } from './harness-meta'
import { PROTOCOL_SHORT } from './pairing'

type CatalogHarness = RuntimeCatalog['harnesses'][number]
type CatalogProvider = RuntimeCatalog['providers'][number]

/** 131072 → 128K，168000 → 168K，1048576 / 1000000 → 1M：整 1024 倍的按二进制算，其余按十进制 */
export function contextText(n?: number): string | undefined {
  if (!n) return undefined
  const k = n % 1024 === 0 ? 1024 : 1000
  if (n >= k * k) return `${+(n / (k * k)).toFixed(2)}M`
  return `${Math.round(n / k)}K`
}

/** 同一组里显示名重复的（网关常把同一个模型挂在几个 ID 下），在名字下面写出 ID 区分。 */
function markDuplicates(models: PickerModel[]): PickerModel[] {
  const count = new Map<string, number>()
  for (const m of models) count.set(m.label, (count.get(m.label) ?? 0) + 1)
  return models.map((m) => (count.get(m.label)! > 1 && m.model && !m.detail ? { ...m, detail: m.model } : m))
}

const tagsOf = (m: CatalogModel, extra?: string) => {
  const tags = [extra, m.reasoning ? '推理' : undefined, contextText(m.contextWindow)].filter((t): t is string => Boolean(t))
  return tags.length ? tags : undefined
}

/** 列表来源的一句话：实时 / 缓存 / 列不出来时用的预设。 */
export function listSource(list?: CatalogList): string | undefined {
  if (!list) return undefined
  if (list.error === '正在获取…') return '正在获取模型…'
  if (list.error) return list.models.length ? `列取失败，显示上次结果：${list.error}` : list.error
  return undefined
}

/** 上游已不再列出的放最后、置灰；同一个厂商 ID 配了别名时，选中后写别名（别名上还挂着价格、上下文这些手填项）。 */
function toModel(m: CatalogModel, group: string, provider?: string, extra?: string): PickerModel {
  return {
    key: `${group}:${m.id}`,
    model: m.alias ?? m.id,
    ...(m.alias && m.alias !== m.id ? { aliases: [m.id], detail: `别名 ${m.alias}` } : {}),
    // 写别名时不再带 provider：别名已经指定了 provider
    ...(provider && !m.alias ? { provider } : {}),
    label: m.label && m.label !== m.id ? m.label : m.id,
    tags: m.deprecated ? ['已下架'] : tagsOf(m, extra),
    ...(m.efforts?.length ? { efforts: m.efforts, defaultEffort: m.defaultEffort } : {}),
    available: !m.deprecated,
    ...(m.deprecated ? { reason: '上游已不再列出这个模型' } : {}),
  }
}

const sortModels = (list: CatalogModel[]) => [...list].sort((a, b) => Number(!!a.deprecated) - Number(!!b.deprecated))

function ownGroup(h: CatalogHarness, label: string, pairingOk: boolean, pairingReason?: string): PickerGroup | undefined {
  if (h.capabilities.requiresProvider) return undefined
  const ready = pairingOk && h.ownReady !== false
  const reason = !pairingOk ? pairingReason : h.ownReady === false ? h.ownReason ?? '自带账号未登录' : undefined
  const listed = markDuplicates(sortModels(h.own?.models ?? []).map((m) => toModel(m, 'own', undefined)))
  const models: PickerModel[] = [{ key: 'own:', label: '默认模型', available: ready, ...(reason ? { reason } : {}) }, ...listed.map((m) => (ready ? m : { ...m, available: false, reason }))]
  return { key: 'own', label, note: '自带', hint: ready ? listSource(h.own) : reason, models }
}

/** 网关列出的模型常常不带推理元数据：harness 能传推理强度时，给出常用三档和「默认」，由人决定要不要指定（设置里的路由抽屉同样如此）。 */
const guessEfforts = (h: CatalogHarness, m: CatalogModel, x: PickerModel): PickerModel =>
  h.capabilities.effortOverride && !x.efforts && m.reasoning !== false ? { ...x, efforts: ['low', 'medium', 'high'], effortGuess: true } : x

function providerGroup(h: CatalogHarness, p: CatalogProvider, mode: 'direct' | 'bridge', protocol?: string, upstream?: string): PickerGroup {
  const bridge = mode === 'bridge'
  return {
    key: `p:${p.id}`,
    label: p.displayName,
    icon: providerIconKey({ id: p.id }),
    note: bridge ? '经协议桥' : '直连',
    hint: [bridge && protocol && upstream ? `${h.displayName} 说 ${protocol}，这家给 ${upstream}，中间自动转换` : undefined, p.keyPresent ? undefined : '缺少密钥', listSource(p.models)].filter(Boolean).join(' · ') || undefined,
    models: markDuplicates(sortModels(p.models.models).map((m) => {
      const x = guessEfforts(h, m, toModel(m, `p:${p.id}`, p.id, bridge ? '桥接' : undefined))
      return p.keyPresent ? x : { ...x, available: false, reason: '缺少密钥：去 Provider 里填上' }
    })),
  }
}

/**
 * 模型目录 → 两级选择器的数据（docs/design/32 §6）：
 * 每个 harness 一行；右栏先是「自带」（harness 自己的账号与模型），再是能直连 / 经协议桥搭配的各 provider，最后一组列出搭不上的 provider 和原因。
 */
export function catalogToPicker(catalog: RuntimeCatalog, opts: { defaultHarness?: string; keep?: string[] } = {}): PickerHarness[] {
  const providers = new Map(catalog.providers.map((p) => [p.id, p]))
  return catalog.harnesses
    .filter((h) => (!h.hidden && !isTestOnly(h)) || opts.keep?.includes(h.id))
    .map((h) => {
      const meta = harnessMeta(h)
      const pairs = catalog.pairings.filter((x) => x.harness === h.id)
      const own = pairs.find((x) => x.provider === null)
      const groups: PickerGroup[] = []
      const og = ownGroup(h, meta.own ?? '自带', own?.status !== 'unavailable', own?.reason)
      if (og) groups.push(og)
      const off: PickerModel[] = []
      for (const p of catalog.providers) {
        const pair = pairs.find((x) => x.provider === p.id)
        if (pair && (pair.status === 'direct' || pair.status === 'bridge')) {
          groups.push(providerGroup(h, providers.get(p.id)!, pair.status, pair.protocol && PROTOCOL_SHORT[pair.protocol], pair.upstream && PROTOCOL_SHORT[pair.upstream]))
        } else {
          off.push({ key: `off:${p.id}`, label: p.displayName, info: true, available: false, reason: pair?.reason ?? `${meta.name} 接不了 ${p.protocols.map((x) => PROTOCOL_SHORT[x]).join(' / ')} 协议` })
        }
      }
      if (off.length && groups.length) groups.push({ key: 'off', label: '搭不上的 API', models: off })
      const available = h.available && !h.hidden
      return {
        id: h.id,
        name: meta.name,
        icon: meta.icon,
        own: h.id === 'native' || h.capabilities.requiresProvider ? '直接调接入的 LLM API' : h.ownReady === false ? '自带账号未登录 · 可接 API' : meta.own,
        available,
        reason: h.hidden ? '本空间已隐藏' : h.available ? undefined : h.reason === '正在检测…' ? h.reason : readableReason(h.reason),
        badge: h.id === opts.defaultHarness ? '默认' : undefined,
        groups: groups.length ? groups : off.length ? [{ key: 'off', label: '搭不上的 API', models: off }] : [],
      }
    })
}

/** value 在目录里对应的模型（别名、厂商 ID 都认）。 */
export function findPicked(harnesses: PickerHarness[], v: PickerValue): PickerModel | undefined {
  const h = harnesses.find((x) => x.id === v.harness)
  return h?.groups.flatMap((g) => g.models).find((m) => sameModel(m, v))
}

/** 目录里还有项在后台拉取（模型列表、harness 探测）：过一会儿再取一次。 */
export const catalogPending = (c?: RuntimeCatalog) =>
  !!c && ([...c.harnesses.map((h) => h.own), ...c.providers.map((p) => p.models)].some((l) => l?.error === '正在获取…') || c.harnesses.some((h) => !h.available && h.reason === '正在检测…'))
