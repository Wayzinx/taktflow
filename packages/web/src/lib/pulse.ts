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

/** 浏览器标签页图标：节拍蜂（小尺寸只画轮廓、条纹、眼睛）。index.html 里的静态图标与它的 idle 一致。 */
export const BEE_FAVICON_BODY =
  "<path d='M25 31C15 17 3 21 6.6 30c2.4 6 12 6 18.4 1z' fill='#e6edf3' stroke='#2a241f' stroke-width='3.4' stroke-linejoin='round'/>" +
  "<path d='M39 31c10-14 22-10 18.4-1-2.4 6-12 6-18.4 1z' fill='#e6edf3' stroke='#2a241f' stroke-width='3.4' stroke-linejoin='round'/>" +
  "<path d='M27 25Q25 15 21 10.5M37 25Q39 15 43 10.5' fill='none' stroke='#2a241f' stroke-width='3.6' stroke-linecap='round'/>" +
  "<circle cx='21' cy='10.5' r='3.8' fill='#2a241f'/><circle cx='43' cy='10.5' r='3.8' fill='#2a241f'/>" +
  "<ellipse cx='32' cy='40.5' rx='19' ry='18' fill='#f0b14a'/>" +
  "<path d='M14.6 44q17.4 4.8 34.8 0l-.9 5.2q-16.5 4.4-33 0zM17.4 51.2q14.6 4 29.2 0l-3.6 4.8q-11 3-22 0z' fill='#2a241f'/>" +
  "<ellipse cx='32' cy='40.5' rx='19' ry='18' fill='none' stroke='#2a241f' stroke-width='3.6'/>" +
  "<ellipse cx='25.6' cy='34.6' rx='3.2' ry='3.8' fill='#2a241f'/><ellipse cx='38.4' cy='34.6' rx='3.2' ry='3.8' fill='#2a241f'/>"

/** 图标三态：空闲（节拍蜂）、运行中（右上节拍橙点）、等你（右上琥珀点，优先）。 */
export function pulseIcon(state: 'idle' | 'running' | 'waiting'): string {
  const dot = state === 'idle' ? '' : `<circle cx='54' cy='10' r='9' fill='${state === 'waiting' ? '#e0a526' : '#e8743b'}' stroke='#ffffff' stroke-width='3'/>`
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>${BEE_FAVICON_BODY}${dot}</svg>`)}`
}
