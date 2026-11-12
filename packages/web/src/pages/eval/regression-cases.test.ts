import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DefectDetail, EvalCase } from '@taktflow/core'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ data: undefined as EvalCase[] | undefined }))
vi.mock('../../api', () => ({ useAsync: () => state }))
vi.mock('../../components/ui', () => ({ SkeletonRows: () => null }))
vi.mock('../../lib/router', () => ({ Link: ({ to, children }: { to: string; children: string }) => createElement('a', { href: to }, children) }))
import { RegressionCases } from './regression-cases'

afterEach(() => { state.data = undefined })

it('旧整节点和退役样本没有评测入口，在用样本仍可评测', () => {
  const common = { target: { kind: 'node', workflowId: 'wf', nodeId: 'review' }, source: { kind: 'defect', defectId: 'D-1' } }
  state.data = [
    { ...common, id: 'legacy', title: '旧用例' },
    { ...common, id: 'retired', title: '退役样本', sample: { retiredAt: '2026-11-01' } },
    { ...common, id: 'active', title: '在用样本', sample: { kind: 'must_catch' } },
  ] as EvalCase[]
  const html = renderToStaticMarkup(createElement(RegressionCases, { d: { id: 'D-1' } as DefectDetail, runIds: [] }))
  expect(html.match(/用它评测/g)).toHaveLength(1)
  expect(html).toContain('旧用例 · 本期不回放')
  expect(html).toContain('已退役')
  expect(html).toContain('需要先有逐检查点漏检结论')
})
