import { describe, expect, it } from 'vitest'
import { hasLeadMarks, splitLeadText } from './lead-split'

describe('splitLeadText', () => {
  it('returns one plain segment without marks', () => {
    expect(splitLeadText('今天先跑系分。')).toEqual([{ kind: 'plain', text: '今天先跑系分。' }])
    expect(splitLeadText('')).toEqual([])
  })
  it('splits **待确认** / **下一步** blocks that run until the next mark', () => {
    expect(splitLeadText('PRD v2 已出。\n**待确认**：金额精度用几位？\n**下一步**: 进入系分')).toEqual([
      { kind: 'plain', text: 'PRD v2 已出。' },
      { kind: 'confirm', text: '金额精度用几位？' },
      { kind: 'next', text: '进入系分' },
    ])
  })
  it('keeps an empty block when a mark ends the text', () => {
    expect(splitLeadText('说明 **下一步**')).toEqual([
      { kind: 'plain', text: '说明' },
      { kind: 'next', text: '' },
    ])
  })
  it('leaves other bold text alone', () => {
    expect(splitLeadText('**注意** 这是普通粗体')).toEqual([{ kind: 'plain', text: '**注意** 这是普通粗体' }])
    expect(hasLeadMarks('**注意**')).toBe(false)
    expect(hasLeadMarks('x **待确认** y')).toBe(true)
  })
})
