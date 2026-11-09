import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HIDDEN_GRACE_MS, onTabReturn, whileVisible } from './visible'

class FakeDocument extends EventTarget {
  hidden = false
  set(hidden: boolean) {
    this.hidden = hidden
    this.dispatchEvent(new Event('visibilitychange'))
  }
}
let doc: FakeDocument

beforeEach(() => {
  vi.useFakeTimers()
  doc = new FakeDocument()
  vi.stubGlobal('document', doc)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('隐藏超过宽限才断开，回到前台再连；短暂切走不断', () => {
  const opened: Array<{ closed: boolean }> = []
  const stop = whileVisible(() => {
    const conn = { closed: false }
    opened.push(conn)
    return () => { conn.closed = true }
  })
  expect(opened).toHaveLength(1)
  doc.set(true)
  vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1)
  doc.set(false)
  vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2)
  expect(opened).toEqual([{ closed: false }])

  doc.set(true)
  vi.advanceTimersByTime(HIDDEN_GRACE_MS)
  expect(opened[0]!.closed).toBe(true)
  doc.set(false)
  expect(opened).toHaveLength(2)
  stop()
  expect(opened[1]!.closed).toBe(true)
  doc.set(true)
  doc.set(false)
  expect(opened).toHaveLength(2)
})

it('在后台打开的标签等到可见才连', () => {
  doc.hidden = true
  const open = vi.fn(() => () => {})
  whileVisible(open)
  expect(open).not.toHaveBeenCalled()
  doc.set(false)
  expect(open).toHaveBeenCalledTimes(1)
})

it('onTabReturn 只在隐藏够久（流已断开）后回来时触发', () => {
  const cb = vi.fn()
  const off = onTabReturn(cb)
  doc.set(true)
  vi.advanceTimersByTime(1000)
  doc.set(false)
  expect(cb).not.toHaveBeenCalled()
  doc.set(true)
  vi.advanceTimersByTime(HIDDEN_GRACE_MS)
  doc.set(false)
  expect(cb).toHaveBeenCalledTimes(1)
  off()
  doc.set(true)
  vi.advanceTimersByTime(HIDDEN_GRACE_MS)
  doc.set(false)
  expect(cb).toHaveBeenCalledTimes(1)
})
