import { expect, it } from 'vitest'
import { cursorState, fmtCount } from './quality-meta'

it('大数带千分位（TF-084）', () => {
  expect(fmtCount(902856)).toBe('902,856')
  expect(fmtCount(36229)).toBe('36,229')
})

it('服务端没给事件总数：照旧显示入账位置，补算保留', () => {
  expect(cursorState(902856)).toEqual({ text: '已入账到第 902,856 条事件 · 总数未提供，暂无法判断是否落后', canSync: true })
})

it('给了总数：落后时写落后多少并给补算，追平时不给', () => {
  expect(cursorState(10, 16)).toEqual({ behind: 6, text: '已入账 10 / 共 16 条事件，落后 6 条', canSync: true })
  expect(cursorState(16, 16)).toEqual({ behind: 0, text: '已入账 16 / 共 16 条事件，已追平', canSync: false })
})
