/**
 * TF-015：侧栏的每个导航项都能在 ⌘K 的“页面”分组搜到（之前漏了评测）；
 * TF-090：404 页按地址猜用户要去的页面。
 */
import { describe, expect, it } from 'vitest'
import { SPACE_NAV } from '../../lib/nav'
import { PAGES, suggestPage } from './pages'

describe('⌘K 页面', () => {
  it('覆盖侧栏全部入口', () => {
    const pages = new Set(PAGES.map((p) => p.to))
    expect(SPACE_NAV.map((n) => n.to).filter((to) => !pages.has(to))).toEqual([])
  })

  it('评测能用中文、英文、拼音搜到', () => {
    const evalPage = PAGES.find((p) => p.to === '/eval')!
    for (const w of ['评测', 'eval', 'pingce']) expect(`${evalPage.label} ${evalPage.keywords}`.toLowerCase()).toContain(w)
  })
})

describe('suggestPage', () => {
  it('拼错一两个字母时猜得到', () => {
    expect(suggestPage('/settingss')?.label).toBe('空间设置')
    expect(suggestPage('/attenton')?.label).toBe('待办')
    expect(suggestPage('/requirement')?.label).toBe('需求列表')
    expect(suggestPage('/evl')?.label).toBe('评测')
  })

  it('差太远、或者是开发页时不乱猜', () => {
    expect(suggestPage('/xxx')).toBeUndefined()
    expect(suggestPage('/')).toBeUndefined()
    expect(suggestPage('/uu')).toBeUndefined()
  })
})

describe('侧栏高亮', () => {
  it('只认本页和下级页面，打错的地址不高亮', () => {
    const active = (path: string) => SPACE_NAV.filter((n) => n.active(path)).map((n) => n.label)
    expect(active('/settings')).toEqual(['空间设置'])
    expect(active('/settingss')).toEqual([])
    expect(active('/req/REQ-001')).toEqual(['需求'])
    expect(active('/run/r1')).toEqual(['需求'])
    expect(active('/requirements')).toEqual(['需求'])
    expect(active('/workflows/wf-1')).toEqual(['流水线'])
  })
})
