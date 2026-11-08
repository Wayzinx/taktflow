import type { ProjectOverview } from '@taktflow/core'

/** 脉搏快照（docs/design/25 §4）：只留比较需要的字段。 */
export interface PulseSnap {
  /** 变化签名：不同就让页面刷新。 */
  sig: string
  waiting: number
  running: number
  reqs: Map<string, { title: string; runId?: string; live: boolean; runStatus?: string }>
  attention: Map<string, { requirementId: string; ask: string }>
}

export function pulseSnap(p: ProjectOverview): PulseSnap {
  const reqs = new Map(
    p.requirements.map((r) => {
      const run = r.recentRuns?.find((x) => x.runId === r.latestRunId)
      const live = r.current?.status === 'running' || r.current?.status === 'waiting_human' || r.stages.some((s) => s.status === 'running')
      return [r.id, { title: r.title, runId: r.latestRunId, live, runStatus: run?.status }] as const
    }),
  )
  const attention = new Map(p.attention.map((a) => [a.requestId, { requirementId: a.requirementId, ask: a.ask }] as const))
  const sig = [
    ...p.requirements.map((r) => `${r.id}:${r.status}:${r.latestRunId ?? ''}:${r.current?.nodeId ?? ''}:${r.current?.status ?? ''}:${r.stages.map((s) => s.status[0]).join('')}:${r.recentRuns?.length ?? 0}`),
    ...[...attention.keys()].sort(),
  ].join('|')
  return { sig, waiting: p.attention.length, running: p.requirements.filter((r) => r.stages.some((s) => s.status === 'running')).length, reqs, attention }
}

export type PulseEvent =
  | { type: 'run-ended'; requirementId: string; title: string; runId: string; outcome: 'succeeded' | 'failed' | 'cancelled' | 'ended' }
  | { type: 'waiting'; requirementId: string; title: string; requestId: string; ask: string }

/** 和上一次比：同一次运行从"在跑 / 等人"变成都不是 → 运行结束；新出现的待办 → 等你。首次加载由调用方跳过。 */
export function diffPulse(before: PulseSnap, after: PulseSnap): PulseEvent[] {
  const out: PulseEvent[] = []
  for (const [id, now] of after.reqs) {
    const was = before.reqs.get(id)
    if (!was?.live || now.live || !now.runId || was.runId !== now.runId) continue
    const s = now.runStatus
    out.push({ type: 'run-ended', requirementId: id, title: now.title, runId: now.runId, outcome: s === 'succeeded' || s === 'failed' || s === 'cancelled' ? s : 'ended' })
  }
  for (const [requestId, a] of after.attention) {
    if (before.attention.has(requestId)) continue
    out.push({ type: 'waiting', requirementId: a.requirementId, title: after.reqs.get(a.requirementId)?.title ?? a.requirementId, requestId, ask: a.ask })
  }
  return out
}

const BASE_TITLE = 'taktflow 控制台'
/** 标签页标题：括号里是等你决定的数量。 */
export const pulseTitle = (waiting: number) => (waiting > 0 ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE)

/** 图标三态：空闲（品牌图标）、运行中（右上节拍橙点）、等你（右上琥珀点，优先）。 */
export function pulseIcon(state: 'idle' | 'running' | 'waiting'): string {
  const dot = state === 'idle' ? '' : `<circle cx='22.5' cy='5.5' r='5' fill='${state === 'waiting' ? '%23e0a526' : '%23e8743b'}' stroke='%23ffffff' stroke-width='1.6'/>`
  return (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'%3E%3Crect width='28' height='28' rx='6.5' fill='%2328231f'/%3E%3Crect x='7' y='9' width='2.6' height='10' rx='1.3' fill='%23c9c2b8'/%3E%3Crect x='12.7' y='9' width='2.6' height='10' rx='1.3' fill='%23c9c2b8'/%3E%3Crect x='18.4' y='6' width='2.6' height='16' rx='1.3' fill='%23e8743b'/%3E" +
    dot.replace(/</g, '%3C').replace(/>/g, '%3E') +
    '%3C/svg%3E'
  )
}
