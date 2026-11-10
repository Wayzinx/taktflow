import { useMemo } from 'react'
import type { StewardRuntime } from '@taktflow/core'
import { useAsync } from '../../api'
import { HarnessPicker } from '../harness-picker/harness-picker'
import { useRuntimeCatalog } from '../harness-picker/use-catalog'
import { catalogPending, catalogToPicker } from '../../lib/catalog-picker'
import { choicesToPicker, runtimeLabel } from './runtime-choices'

export { choicesToPicker, runtimeLabel } from './runtime-choices'

/**
 * 管家用哪个 harness × 模型 × 推理强度（docs/design/30 §2、32 §6）：输入框左下角的两级选择器。
 * 模型来自模型目录（自带 + 各 provider 实时列出的）；目录取不到时退回服务端给的已配置组合。
 * value 为空表示跟随默认（偏好 > 空间配置）。服务端不支持（老版本 404）时不渲染。
 */
export function RuntimePicker({ value, onChange }: { value?: StewardRuntime | null; onChange: (next: StewardRuntime | null) => void }) {
  const q = useAsync((d) => d.stewardRuntimeChoices(), [])
  const cq = useRuntimeCatalog()
  const def = q.data?.find((c) => c.isDefault)
  const harnesses = useMemo(
    () => (cq.data ? catalogToPicker(cq.data, { defaultHarness: def?.harness, keep: value?.harness ? [value.harness] : [] }) : choicesToPicker(q.data ?? [])),
    [cq.data, q.data, def?.harness, value?.harness],
  )
  if (q.error || (q.data && q.data.length === 0)) return null
  return (
    <HarnessPicker
      harnesses={harnesses}
      value={value ? { harness: value.harness ?? 'native', model: value.model, provider: value.provider, effort: value.effort } : null}
      onChange={(next) =>
        onChange(
          next
            ? { harness: next.harness, ...(next.model ? { model: next.model } : {}), ...(next.provider ? { provider: next.provider } : {}), ...(next.effort ? { effort: next.effort } : {}) }
            : null,
        )
      }
      defaultLabel={def ? runtimeLabel(def) : '按偏好设置'}
      defaultValue={def ? { harness: def.harness, model: def.model } : undefined}
      loading={q.loading || (cq.loading && !cq.data) || catalogPending(cq.data)}
      ariaLabel="管家用的 harness 与模型"
      className="stw-runtime"
      manageHref="/settings?tab=runtime"
    />
  )
}
