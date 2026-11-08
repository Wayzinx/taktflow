import type { DailyActivity, RunSpark } from '@taktflow/core'

/**
 * 演示数据里的"更早的运行"：只用于需求行迷你柱与读数格趋势（docs/design/25 §3），没有对应的运行详情。
 * [几天前, 结果, Token（千）, 是否任务运行]
 */
const HISTORY: Record<string, Array<[number, RunSpark['status'], number, boolean?]>> = {
  'REQ-001': [[9, 'failed', 180], [8, 'succeeded', 420], [6, 'succeeded', 310], [5, 'succeeded', 60, true], [3, 'succeeded', 380]],
  'REQ-002': [[12, 'succeeded', 520], [10, 'failed', 160], [7, 'succeeded', 610], [4, 'cancelled', 90], [2, 'succeeded', 70, true], [1, 'succeeded', 470]],
  'REQ-003': [[6, 'succeeded', 70], [2, 'failed', 110]],
  'REQ-004': [[11, 'succeeded', 120], [5, 'failed', 140], [3, 'failed', 105]],
}

export function mockHistory(id: string, now = Date.now()): RunSpark[] {
  return (HISTORY[id] ?? []).map(([days, status, k, task], i) => ({ runId: `r-hist-${id.slice(4)}-${i + 1}`, status, startedAt: new Date(now - days * 864e5 - (i % 3) * 36e5).toISOString(), tokens: k * 1000, kind: task ? 'task' : 'workflow' }))
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 与服务端 dailyActivity 同口径：最近 14 天含今天、按运行开始日计、无活动补 0。 */
export function mockDaily(runs: RunSpark[], now = new Date(), days = 14): DailyActivity[] {
  const series = Array.from({ length: days }, (_, i) => ({ day: day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i))), runs: 0, tokens: 0 }))
  const index = new Map(series.map((s) => [s.day, s]))
  for (const r of runs) {
    const s = index.get(day(new Date(r.startedAt)))
    if (s) {
      s.runs++
      s.tokens += r.tokens
    }
  }
  return series
}
