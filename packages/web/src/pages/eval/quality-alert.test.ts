import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { QualityStatus } from '@taktflow/core'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ data: undefined as QualityStatus | undefined, error: undefined as Error | undefined }))
vi.mock('../../api', () => ({ useAsync: () => ({ ...state, reload: () => {} }) }))
vi.mock('../../lib/router', () => ({ Link: ({ to, children }: { to: string; children: string }) => createElement('a', { href: to }, children) }))
import { QualityAlert } from './quality-alert'

afterEach(() => { state.data = undefined; state.error = undefined })

it('断链告警包含断点、影响范围和查看入口，健康链不报警', () => {
  state.data = { ok: false, brokenAt: 287 } as QualityStatus
  const html = renderToStaticMarkup(createElement(QualityAlert, { what: '评测结论' }))
  expect(html).toContain('role="alert"')
  expect(html).toContain('287')
  expect(html).toContain('评测结论可能不可信')
  expect(html).toContain('/settings?tab=quality')
  state.data = { ok: true } as QualityStatus
  expect(renderToStaticMarkup(createElement(QualityAlert, { what: '评测结论' }))).toBe('')
})

it('状态读取失败不能静默隐藏可信度提示，给出重试', () => {
  state.error = new Error('连接失败')
  const html = renderToStaticMarkup(createElement(QualityAlert, { what: '缺陷归因' }))
  expect(html).toContain('可信度尚未确认')
  expect(html).toContain('重试')
})

it('锚点落后提示修复，不误称断链', () => {
  state.data = { ok: false, anchorBehind: true } as QualityStatus
  const html = renderToStaticMarkup(createElement(QualityAlert, { what: '评测结论' }))
  expect(html).toContain('链完整但锚点落后')
  expect(html).not.toContain('断链')
})
