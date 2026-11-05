import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DataSource } from './source'

export type { AgentTraceView, DataSource, EvalOutputSnapshot, NodeView, RepoPatch, ScorecardBy, WorkflowRevisionDetail } from './source'
export { WorkflowConflictError } from './source'

const SourceContext = createContext<DataSource | null>(null)

/**
 * 数据源注入点：直接给一个 DataSource（嵌入模式），或给一个异步选择函数（独立页面，见 ./pick）。
 * 本模块不引用演示数据，嵌入产物里没有 mock 代码路径。
 */
export function DataProvider({ source, children, fallback }: { source: DataSource | (() => Promise<DataSource>); children: ReactNode; fallback: ReactNode }) {
  const [picked, setPicked] = useState<DataSource | null>(typeof source === 'function' ? null : source)
  useEffect(() => {
    if (typeof source !== 'function') {
      setPicked(source)
      return
    }
    let alive = true
    void source().then((ds) => alive && setPicked(ds))
    return () => {
      alive = false
    }
  }, [source])
  if (!picked) return <>{fallback}</>
  return <SourceContext.Provider value={picked}>{children}</SourceContext.Provider>
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
