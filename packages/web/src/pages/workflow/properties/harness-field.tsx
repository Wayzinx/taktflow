import { useMemo } from 'react'
import type { HarnessSelector } from '@taktflow/core'
import { useAsync } from '../../../api'
import { HarnessPicker } from '../../../components/harness-picker/harness-picker'
import { useRuntimeCatalog } from '../../../components/harness-picker/use-catalog'
import { catalogPending, catalogToPicker } from '../../../lib/catalog-picker'

/**
 * 节点用什么跑：harness × 模型 × 推理强度，和角色档案、管家用同一个选择器（docs/design/32 §6）。
 * 留空跟随角色；按钮上画角色当前的组合。改 harness / 模型时保留节点原有的备选。
 */
export function HarnessField({ id, role, value, disabled, onCommit }: { id: string; role?: string; value?: HarnessSelector; disabled: boolean; onCommit: (next: HarnessSelector | undefined) => void }) {
  const cq = useRuntimeCatalog()
  const space = useAsync((ds) => ds.space(), []) // ux-audit: ok 取角色默认组合，不单独成区
  const inherited = space.data?.agents.find((a) => a.role === role)?.harness
  const harnesses = useMemo(() => (cq.data ? catalogToPicker(cq.data, { keep: [value?.harness, inherited?.harness].filter((h): h is string => !!h) }) : []), [cq.data, value?.harness, inherited?.harness])
  return (
    <div id={id}>
      <HarnessPicker
        harnesses={harnesses}
        value={value ?? null}
        disabled={disabled}
        onChange={(next) => onCommit(next ? { harness: next.harness, ...(next.model ? { model: next.model } : {}), ...(next.provider ? { provider: next.provider } : {}), ...(next.effort ? { effort: next.effort } : {}), ...(value?.fallback ? { fallback: value.fallback } : {}) } : undefined)}
        defaultLabel={role ? `跟随角色 ${role}` : '跟随角色'}
        defaultValue={inherited}
        placement="bottom-start"
        loading={(cq.loading && !cq.data) || catalogPending(cq.data)}
        className="hp-field"
        ariaLabel="节点的 harness 与模型"
        manageHref="/settings?tab=runtime"
      />
    </div>
  )
}
