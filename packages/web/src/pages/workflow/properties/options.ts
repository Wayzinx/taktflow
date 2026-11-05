import { useAsync } from '../../../api'

export interface Option {
  value: string
  label: string
}

/** 角色下拉：空间里配置的 agent 角色。读取失败时给一组常用角色兜底，表单仍可用。 */
const FALLBACK_ROLES = ['pm', 'architect', 'dev', 'test-designer', 'automation', 'reviewer', 'judge']

export function useRoleOptions(): Option[] {
  const { data } = useAsync((ds) => ds.space(), [])
  const roles = data?.agents.length ? data.agents.map((a) => ({ value: a.role, label: a.title ? `${a.role} · ${a.title}` : a.role })) : FALLBACK_ROLES.map((r) => ({ value: r, label: r }))
  return roles
}

export function useHarnessOptions(): Option[] {
  const { data } = useAsync((ds) => ds.harnesses(), [])
  return (data ?? []).map((h) => ({ value: h.id, label: h.available ? h.displayName : `${h.displayName}（不可用）` }))
}

/** 当前值不在选项里（例如手写的角色）时补一项，避免下拉把它吞掉。 */
export function withCurrent(options: Option[], value: string | undefined): Option[] {
  if (!value || options.some((o) => o.value === value)) return options
  return [{ value, label: `${value}（未在空间中定义）` }, ...options]
}
