import { describe, expect, it, vi, afterEach } from 'vitest'
import type { KeyboardEvent } from 'react'
import { trapKeys } from './dialog'

afterEach(() => vi.unstubAllGlobals())

function key(key: string, shiftKey = false, count = 2, active: 'first' | 'last' | 'panel' = 'first') {
  const first = { offsetParent: {}, focus: vi.fn() }
  const last = { offsetParent: {}, focus: vi.fn() }
  const panel = { querySelectorAll: () => count ? [first, last] : [], focus: vi.fn() }
  vi.stubGlobal('document', { activeElement: active === 'panel' ? panel : active === 'last' ? last : first })
  const e = { key, shiftKey, currentTarget: panel, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  const close = vi.fn()
  trapKeys(e as unknown as KeyboardEvent<HTMLElement>, close)
  return { e, first, last, panel, close }
}

describe('模态框键盘循环', () => {
  it('Esc 关闭并阻止按键传给下层', () => {
    const r = key('Escape')
    expect(r.close).toHaveBeenCalledOnce()
    expect(r.e.preventDefault).toHaveBeenCalledOnce()
    expect(r.e.stopPropagation).toHaveBeenCalledOnce()
  })

  it('首尾 Tab 循环，面板本身获得焦点时 Shift Tab 也留在框内', () => {
    expect(key('Tab', false, 2, 'last').first.focus).toHaveBeenCalledOnce()
    expect(key('Tab', true).last.focus).toHaveBeenCalledOnce()
    expect(key('Tab', true, 2, 'panel').last.focus).toHaveBeenCalledOnce()
  })

  it('所有按钮不可聚焦时 Tab 仍留在面板', () => {
    const r = key('Tab', false, 0)
    expect(r.panel.focus).toHaveBeenCalledOnce()
    expect(r.e.preventDefault).toHaveBeenCalledOnce()
  })
})
