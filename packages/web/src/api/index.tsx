import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createHttpSource, probeApi } from './client'
import type { DataSource } from './source'

export type { CrudSource, DataSource, EvalOutputSnapshot, KnowledgeSource, RepoPatch, ScorecardBy, StewardSource, StewardThreadDetail, WorkflowRevisionDetail } from './source'
export { RevisionConflictError, RewindConflictError, RuntimeConflictError, WorkflowConflictError } from './source'

const SourceContext = createContext<DataSource | null>(null)

/** ?mock=1 或 VITE_MOCK=1 强制演示数据；否则探测真实 API，不可达时回退到演示数据（演示数据单独分包，连真实后端时不下载）。 */
async function pickSource(): Promise<DataSource> {
  const forced = new URLSearchParams(location.search).get('mock') === '1' || import.meta.env.VITE_MOCK === '1'
  if (!forced && (await probeApi())) return createHttpSource()
  return (await import('./mock-source')).createMockSource()
}

export function DataProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [source, setSource] = useState<DataSource | null>(null)
  useEffect(() => {
    void pickSource().then(setSource)
  }, [])
  if (!source) return <>{fallback}</>
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>
}

export function useSource(): DataSource {
  const s = useContext(SourceContext)
  if (!s) throw new Error('useSource 必须在 DataProvider 内使用')
  return s
}

// 全局失效：写操作（审批、编辑产物）之后让所有查询重新拉取，保留旧数据避免闪烁
let version = 0
const subs = new Set<() => void>()
export function invalidate() {
  version++
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

export interface AsyncState<T> {
  data?: T
  error?: Error
  loading: boolean
  reload: () => void
}

export function useAsync<T>(fn: (ds: DataSource) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const ds = useSource()
  const v = useSyncExternalStore(subscribe, () => version)
  const key = JSON.stringify(deps)
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ key: string; data?: T; error?: Error; loading: boolean }>({ key, loading: true })
  useEffect(() => {
    let alive = true
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, loading: true }))
    fn(ds).then(
      (data) => alive && setState({ key, data, loading: false }),
      (error: Error) => alive && setState((s) => ({ ...s, key, error, loading: false })),
    )
    return () => {
      alive = false
    }
    // fn 每次渲染都是新函数，依赖由调用方通过 deps 声明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, v, tick, key])
  const fresh = state.key === key
  return { data: fresh ? state.data : undefined, error: fresh ? state.error : undefined, loading: !fresh || state.loading, reload: () => setTick((t) => t + 1) }
}
