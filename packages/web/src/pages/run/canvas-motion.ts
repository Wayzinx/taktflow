import { useEffect, useMemo, useRef, useState } from 'react'
import type { Edge } from '@xyflow/react'
import type { GraphNode, RunDetail } from '@taktflow/core'
import type { FlowNode, Layout } from './dag-layout'

/** 回放把整次运行压到这么长（docs/design/27 §2.1）。 */
const REPLAY_MS = 6000
const REPLAY_TICK = 80

/**
 * 节点刚完成（运行中 → 成功）：记下时间，出边各送一颗信号到下游。
 * 首屏已经完成的节点不算"刚完成"，不播。
 */
export function useCompletionPulses(nodes: GraphNode[]): Map<string, number> {
  const prev = useRef<Map<string, string> | undefined>(undefined)
  const [pulses, setPulses] = useState<Map<string, number>>(() => new Map())
  useEffect(() => {
    const before = prev.current
    prev.current = new Map(nodes.map((n) => [n.id, n.status]))
    if (!before) return
    const fresh = nodes.filter((n) => n.status === 'succeeded' && before.has(n.id) && before.get(n.id) !== 'succeeded')
    if (!fresh.length) return
    const now = Date.now()
    setPulses((p) => {
      const m = new Map(p)
      for (const n of fresh) m.set(n.id, now)
      return m
    })
  }, [nodes])
  return pulses
}

export type ReplayPhase = 'wait' | 'run' | 'done'

export interface Replay {
  playing: boolean
  /** 能回放：运行已结束且至少有一个节点有开始时间。 */
  available: boolean
  /** 0..1 */
  progress: number
  start(): void
  stop(): void
  phaseOf(id: string): ReplayPhase | undefined
  /** 目标节点在回放里开始的时刻（作为彗星的重播键）；还没开始为 undefined。 */
  arrivedAt(id: string): number | undefined
}

/**
 * 回放：按各节点真实的开始 / 结束时间，把整次运行压到 6 秒重演一遍。
 * 只改节点与边的类名（等待 / 在跑 / 完成），不动布局；每 80ms 推进一次，过渡交给 CSS。
 */
export function useReplay(detail: RunDetail): Replay {
  const span = useMemo(() => {
    const rows = Object.entries(detail.run.nodes)
      .map(([id, s]) => ({ id, start: s.startedAt ? Date.parse(s.startedAt) : NaN, end: s.endedAt ? Date.parse(s.endedAt) : NaN }))
      .filter((r) => Number.isFinite(r.start))
    const t0 = Math.min(...rows.map((r) => r.start))
    const t1 = Math.max(...rows.map((r) => (Number.isFinite(r.end) ? r.end : r.start)))
    return { rows: new Map(rows.map((r) => [r.id, r])), t0, t1: Math.max(t1, t0 + 1) }
  }, [detail.run.nodes])
  const finished = detail.run.status === 'succeeded' || detail.run.status === 'failed' || detail.run.status === 'cancelled'
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (elapsed === null) return
    if (elapsed >= REPLAY_MS + 600) {
      setElapsed(null)
      return
    }
    const t = setTimeout(() => setElapsed((e) => (e === null ? null : e + REPLAY_TICK)), REPLAY_TICK)
    return () => clearTimeout(t)
  }, [elapsed])
  // 换了运行或运行重新跑起来就停
  useEffect(() => setElapsed(null), [detail.run.runId, finished])
  const now = elapsed === null ? undefined : span.t0 + (Math.min(elapsed, REPLAY_MS) / REPLAY_MS) * (span.t1 - span.t0)
  return {
    playing: elapsed !== null,
    available: finished && span.rows.size > 0,
    progress: elapsed === null ? 0 : Math.min(1, elapsed / REPLAY_MS),
    start: () => setElapsed(0),
    stop: () => setElapsed(null),
    phaseOf(id) {
      if (now === undefined) return undefined
      const r = span.rows.get(id)
      if (!r || r.start > now) return 'wait'
      return Number.isFinite(r.end) && r.end <= now ? 'done' : 'run'
    },
    arrivedAt(id) {
      if (now === undefined) return undefined
      const r = span.rows.get(id)
      return r && r.start <= now ? r.start : undefined
    },
  }
}

const cls = (...xs: Array<string | false | undefined>) => xs.filter(Boolean).join(' ') || undefined

/**
 * 把悬停 / 选中、完成交接、回放三种动效状态叠到布局结果上：只加类名与 edge.data，不重算布局。
 * 悬停只亮一跳（直接上下游），不然线性流水线会整张图都亮。
 */
export function decorate(layout: Layout, focus: string | undefined, pulses: Map<string, number>, replay: Replay): { nodes: FlowNode[]; edges: Edge[] } {
  const near = new Set<string>()
  if (focus) {
    near.add(focus)
    for (const e of layout.edges) {
      if (e.source === focus) near.add(e.target)
      if (e.target === focus) near.add(e.source)
    }
  }
  const nodes = layout.nodes.map((n) => {
    if (n.type !== 'dag') return n
    const phase = replay.phaseOf(n.id)
    const c = cls(n.className, focus && near.has(n.id) && 'is-hl', phase && `rp-${phase}`)
    return c === n.className ? n : { ...n, className: c }
  })
  const edges = layout.edges.map((e) => {
    const hl = Boolean(focus) && (e.source === focus || e.target === focus)
    const arrived = replay.playing ? replay.arrivedAt(e.target) : undefined
    const pulse = replay.playing ? arrived : pulses.get(e.source)
    if (!hl && pulse === undefined && !replay.playing) return e
    return {
      ...e,
      className: cls(e.className, hl && 'is-hl', replay.playing && arrived !== undefined && 'rp-on'),
      data: { ...e.data, hl, pulse },
    }
  })
  return { nodes, edges }
}
