/** TF-043 / TF-078：面包屑统一以空间名开头；标签页标题从面包屑末项取字。 */
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { nodeText, withSpaceCrumb } from './page-title'

describe('nodeText', () => {
  it('取出元素里的文字', () => {
    expect(nodeText(createElement('span', { className: 'mono' }, 'REQ-001'))).toBe('REQ-001')
    expect(nodeText(['需求 ', createElement('b', null, 3), null, false])).toBe('需求 3')
    expect(nodeText(undefined)).toBe('')
  })
})

describe('withSpaceCrumb', () => {
  it('空间内页面前面补上可点回总览的空间名', () => {
    expect(withSpaceCrumb([{ label: '空间设置' }], '管家规则演示')).toEqual([{ label: '管家规则演示', to: '/' }, { label: '空间设置' }])
    expect(withSpaceCrumb([{ label: '需求', to: '/requirements' }, { label: 'REQ-001' }], '演示').map((c) => c.label)).toEqual(['演示', '需求', 'REQ-001'])
  })

  it('页面已经以空间名开头时不重复；全局页不加', () => {
    expect(withSpaceCrumb([{ label: '管家规则演示' }, { label: '总览' }], '管家规则演示')).toEqual([{ label: '管家规则演示', to: '/' }, { label: '总览' }])
    expect(withSpaceCrumb([{ label: '全部空间' }], undefined)).toEqual([{ label: '全部空间' }])
  })
})
