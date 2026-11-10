import type { StewardRuntimeChoice } from '@taktflow/core'
import { providerIconKey } from '../brand/brand-icon'
import type { PickerGroup, PickerHarness } from '../harness-picker/harness-picker'
import { harnessMeta } from '../../lib/harness-meta'
import { pairingText } from '../../lib/pairing'

const modelName = (c: StewardRuntimeChoice) => (c.model ? c.modelLabel ?? c.model : '默认模型')
/** 按钮上的短名：内置只写模型；外部 harness 写 harness · 模型（自带模型只写 harness）。 */
export function runtimeLabel(c: StewardRuntimeChoice): string {
  if (c.harness === 'native') return modelName(c)
  return c.model ? `${harnessMeta({ id: c.harness, displayName: c.harnessLabel, source: 'builtin' }).name} · ${modelName(c)}` : harnessMeta({ id: c.harness, displayName: c.harnessLabel, source: 'builtin' }).name
}

/** 服务端给的平铺组合 → 选择器的 harness / 分组 / 模型三层：不带模型的是「自带」，带模型的按 provider 分组。 */
export function choicesToPicker(choices: StewardRuntimeChoice[]): PickerHarness[] {
  const byHarness = new Map<string, StewardRuntimeChoice[]>()
  for (const c of choices) byHarness.set(c.harness, [...(byHarness.get(c.harness) ?? []), c])
  return [...byHarness].map(([id, cs]) => {
    const meta = harnessMeta({ id, displayName: cs[0]!.harnessLabel, source: id === 'native' ? 'native' : 'builtin' })
    const groups = new Map<string, PickerGroup>()
    for (const c of cs) {
      const key = c.model ? `p:${c.provider ?? ''}` : 'own'
      const group = groups.get(key) ?? {
        key,
        label: c.model ? c.provider ?? '已配置的模型' : meta.own ?? '自带',
        icon: c.model && c.provider ? providerIconKey({ id: c.provider }) : undefined,
        note: c.model ? (c.pairing?.mode === 'bridge' ? '经协议桥' : c.pairing?.mode === 'direct' ? '直连' : undefined) : '自带',
        models: [],
      }
      group.models.push({
        key: c.model ?? '',
        model: c.model,
        provider: c.provider,
        label: modelName(c),
        tags: c.pairing?.mode === 'bridge' ? ['桥接'] : undefined,
        available: c.available,
        reason: c.available ? (c.pairing?.mode === 'bridge' ? pairingText(c.pairing) : undefined) : c.reason,
      })
      groups.set(key, group)
    }
    const available = cs.some((c) => c.available)
    return {
      id,
      name: meta.name,
      icon: meta.icon,
      own: id === 'native' ? '直接调接入的 LLM API' : meta.own,
      available,
      reason: available ? undefined : cs.find((c) => c.reason)?.reason,
      badge: cs.some((c) => c.isDefault) ? '默认' : undefined,
      groups: [...groups.values()],
    }
  })
}
