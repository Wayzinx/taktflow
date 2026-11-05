import { describe, expect, it } from 'vitest'
import { collapse, conflictCount, hasConflictMarkers, lineDiff, parseUnifiedDiff } from './line-diff'

describe('line-diff', () => {
  it('删除排在新增前，行号正确', () => {
    const d = lineDiff('a\nb\nc', 'a\nX\nc')
    expect(d.map((l) => `${l.t}${l.a ?? '_'}/${l.b ?? '_'}`)).toEqual([' 1/1', '-2/_', '+_/2', ' 3/3'])
  })
  it('折叠未改动的大段', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const rows = collapse(lineDiff(a, a.replace('l10', 'X')), 2)
    expect(rows[0]).toEqual({ t: 'gap', count: 8 })
    expect(rows.at(-1)).toEqual({ t: 'gap', count: 7 })
  })
  it('解析统一 diff', () => {
    const rows = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -3,2 +3,2 @@\n x\n-y\n+z\n')
    expect(rows).toEqual([{ t: '@', text: '@@ -3,2 +3,2 @@' }, { t: ' ', text: 'x', a: 3, b: 3 }, { t: '-', text: 'y', a: 4 }, { t: '+', text: 'z', b: 4 }])
  })
  it('冲突标记', () => {
    const m = 'a\n<<<<<<< 你的修改\nb\n=======\nc\n>>>>>>> 最新修订\nd'
    expect(conflictCount(m)).toBe(1)
    expect(hasConflictMarkers(m)).toBe(true)
    expect(hasConflictMarkers('a = 1\n// ====')).toBe(false)
  })
})
