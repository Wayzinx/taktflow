import { useMemo } from 'react'
import type { StewardRuntime } from '@taktflow/core'
import { useAsync } from '../../api'
import { HarnessPicker } from '../harness-picker/harness-picker'
import { choicesToPicker, runtimeLabel } from './runtime-choices'

export { choicesToPicker, runtimeLabel } from './runtime-choices'

/**
 * 管家用哪个 harness × 模型（docs/design/30 §2、32 §6）：输入框左下角的两级选择器。
 * value 为空表示跟随默认（偏好 > 空间配置）。服务端不支持（老版本 404）时不渲染。
 */
export function RuntimePicker({ value, onChange }: { value?: StewardRuntime | null; onChange: (next: StewardRuntime | null) => void }) {
  const q = useAsync((d) => d.stewardRuntimeChoices(), [])
  const harnesses = useMemo(() => choicesToPicker(q.data ?? []), [q.data])
  if (q.error || (q.data && q.data.length === 0)) return null
  const def = q.data?.find((c) => c.isDefault)
  return (
    <HarnessPicker
      harnesses={harnesses}
      value={value ? { harness: value.harness ?? 'native', model: value.model } : null}
      onChange={(next) => onChange(next ? { harness: next.harness, model: next.model } : null)}
      defaultLabel={def ? runtimeLabel(def) : '按偏好设置'}
      defaultValue={def ? { harness: def.harness, model: def.model } : undefined}
      loading={q.loading}
      ariaLabel="管家用的 harness 与模型"
      className="stw-runtime"
      manageHref="/settings?tab=runtime"
    />
  )
}
