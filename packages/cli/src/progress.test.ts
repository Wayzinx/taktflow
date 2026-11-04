import { expect, it } from 'vitest'
import type { EventEnvelope, WorkflowDefinition } from '@taktflow/core'
import { createColors, type Printer } from './output.js'
import { ProgressFeed } from './progress.js'
import { serializeRun } from './resume-lock.js'

it('批量事件仍按事件时间计算成功和失败耗时，输出一行并带阶段', () => {
  const lines: string[] = []
  const printer: Printer = { json: false, colors: createColors(false), text: () => {}, data: () => {}, warn: (line) => { lines.push(line) } }
  const workflow: WorkflowDefinition = { id: 'flow', title: 'flow', version: '1', stages: [{ id: 'build', title: '构建' }], nodes: [{ id: 'n', title: 'node', kind: 'script', stage: 'build', run: 'true' }] }
  const feed = new ProgressFeed(printer, workflow)
  const event = (seq: number, type: string, ts: string, data = {}) => ({ seq, type, ts: `2026-01-01T00:00:${ts}Z`, nodeId: 'n', data }) as EventEnvelope
  feed.consume(event(1, 'node.started', '00.000'), true)
  feed.consume(event(2, 'node.finished', '02.500'), true)
  feed.consume(event(3, 'node.started', '03.000'), true)
  feed.consume(event(4, 'node.failed', '07.000', { error: 'bad\n  detail\rmore' }), true)
  feed.consume(event(5, 'judge.verdict', '08.000', { verdicts: [{ subject: 'case\n1', category: 'product_bug' }] }), true)
  expect(feed.consume(event(5, 'judge.verdict', '08.000'), true)).toBe(false)
  expect(lines).toHaveLength(5)
  expect(lines[1]).toContain('[build] n ✔ succeeded 2.5s')
  expect(lines[3]).toContain('4.0s bad detail more')
  expect(lines.every((line) => !/[\r\n]/.test(line))).toBe(true)
})

it('同一运行串行恢复，前一次失败不阻断队列，不同运行独立', async () => {
  const steps: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = serializeRun('r', async () => { steps.push('first'); await gate; throw new Error('fail') })
  const handled = first.catch(() => { steps.push('failed') })
  const second = serializeRun('r', async () => { steps.push('second') })
  await serializeRun('other', async () => { steps.push('other') })
  expect(steps).toEqual(['first', 'other'])
  release()
  await Promise.all([handled, second])
  expect(steps).toEqual(['first', 'other', 'failed', 'second'])
})
