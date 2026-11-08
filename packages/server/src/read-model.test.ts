import { expect, it } from 'vitest'
import type { RunState } from '@taktflow/core'
import { dailyActivity } from './read-model.js'

const run = (runId: string, startedAt: string): RunState => ({ runId, workflowId: 'wf', workflowVersion: '1', requirementId: 'REQ-1', status: 'succeeded', startedAt, args: {}, nodes: {}, expansions: [] })

it('每日活动：最近 14 天含今天、无活动补 0，Token 取每次运行的事件用量', () => {
  const now = new Date(2026, 10, 8, 15)
  const runs = [run('a', new Date(2026, 10, 8, 9).toISOString()), run('b', new Date(2026, 10, 8, 10).toISOString()), run('c', new Date(2026, 10, 1, 9).toISOString()), run('old', new Date(2026, 9, 20).toISOString())]
  const daily = dailyActivity(runs, { a: { inputTokens: 100, outputTokens: 20 }, b: { inputTokens: 5, outputTokens: 5 }, old: { inputTokens: 999, outputTokens: 0 } }, now)
  expect(daily).toHaveLength(14)
  expect(daily[0]!.day).toBe('2026-10-26')
  expect(daily.at(-1)).toEqual({ day: '2026-11-08', runs: 2, tokens: 130 })
  expect(daily.find((d) => d.day === '2026-11-01')).toEqual({ day: '2026-11-01', runs: 1, tokens: 0 })
  expect(daily.reduce((n, d) => n + d.runs, 0)).toBe(3)
})
