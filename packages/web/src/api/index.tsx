import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { LinkSpaceProvider } from '../lib/router'
import { connectApi, createHttpSource } from './client'
import { demoMode, readOnlyDemo } from './demo'
import type { DataSource } from './source'

export type { CrudSource, DataSource, EvalOutputSnapshot, KnowledgeSource, RepoPatch, ScorecardBy, StewardSource, StewardThreadDetail, WorkflowRevisionDetail } from './source'
export { RevisionConflictError, RewindConflictError, RoleConflictError, RuntimeConflictError, WorkflowConflictError } from './source'
export { DEMO_READONLY_MESSAGE, demoMode, type DemoMode } from './demo'

const SourceContext = createContext<DataSource | null>(null)

/**
 * 只有显式要求（?mock=1 / VITE_MOCK=1，见 ./demo）才用演示数据；否则连真实 API，慢就退避重试（connectApi），
 * 最终连不上返回 undefined，由外壳显示"连不上 takt serve"。演示数据单独分包，连真实后端时不下载。
 */
async function pickSource(onRetry: (attempt: number) => void): Promise<DataSource | undefined> {
  const demo = demoMode()
  if (demo) {
    const mock = (await import('./mock-source')).createMockSource()
    return readOnlyDemo(mock)
  }
  return (await connectApi({ onRetry })) ? createHttpSource() : undefined
}

type Boot = { phase: 'connecting'; attempt: number } | { phase: 'failed' } | { phase: 'ready'; source: DataSource }

/** fallback：连接中（attempt 是第几次重试，0 为首次）；failed：重试用尽仍连不上，retry 重新连。 */
export function DataProvider({ children, fallback, failed }: { children: ReactNode; fallback: (attempt: number) => ReactNode; failed: (retry: () => void) => ReactNode }) {
  const [boot, setBoot] = useState<Boot>({ phase: 'connecting', attempt: 0 })
  const [round, setRound] = useState(0)
  useEffect(() => {
    let alive = true
    void pickSource((attempt) => alive && setBoot({ phase: 'connecting', attempt })).then(
      (source) => alive && setBoot(source ? { phase: 'ready', source } : { phase: 'failed' }),
      () => alive && setBoot({ phase: 'failed' }),
    )
    return () => {
      alive = false
    }
  }, [round])
  const retry = () => {
    setBoot({ phase: 'connecting', attempt: 0 })
    setRound((r) => r + 1)
  }
  if (boot.phase === 'failed') return <>{failed(retry)}</>
  if (boot.phase === 'connecting') return <>{fallback(boot.attempt)}</>
  return <SourceContext.Provider value={boot.source}>{children}</SourceContext.Provider>
}

/**
 * 子树里的空间内接口和页内链接都固定到这个空间（docs/design/28 §2）：Solo 是全局页，实体视图按各自的 spaceId 取数、跳转。
 * spaceId 为空时原样透传。
 */
export function SpaceScope({ spaceId, children }: { spaceId?: string; children: ReactNode }) {
  const ds = useSource()
  if (!spaceId) return <>{children}</>
  return (
    <SourceContext.Provider value={ds.forSpace(spaceId)}>
      <LinkSpaceProvider value={spaceId}>{children}</LinkSpaceProvider>
    </SourceContext.Provider>
  )
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

/** 成员 id → 显示名（空间成员表里的 name）；找不到就原样用 id。 */
export function useMemberName(): (id: string) => string {
  const members = useAsync((ds) => ds.space(), []).data?.members
  return (id) => members?.find((m) => m.id === id)?.name ?? id
}
