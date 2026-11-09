import { describe, expect, it } from 'vitest'
import type { StewardThread } from '@taktflow/core'
import { groupThreads } from './thread-groups'

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()
const th = (id: string, extra: Partial<StewardThread> = {}): StewardThread => ({ id, title: id, createdAt: iso(30), updatedAt: iso(0), ...extra })
const names = { a: '空间 A', b: '空间 B' } as Record<string, string>
const shape = (list: StewardThread[], by: Parameters<typeof groupThreads>[1]) => groupThreads(list, by, (id) => names[id]).map((g) => [g.label, g.items.map((t) => t.id)])

describe('groupThreads（docs/design/30 §2）', () => {
  it('置顶的总在最上面一组，不再出现在别的组里', () => {
    const list = [th('p', { pinnedAt: iso(0), updatedAt: iso(9) }), th('t'), th('y', { updatedAt: iso(1) })]
    expect(shape(list, 'time')).toEqual([
      ['置顶', ['p']],
      ['今天', ['t']],
      ['昨天', ['y']],
    ])
  })

  it('按空间：组按最近的会话排，没关联空间的放最后', () => {
    const list = [th('x'), th('a1', { spaceId: 'a', updatedAt: iso(1) }), th('b1', { spaceId: 'b', updatedAt: iso(2) }), th('a2', { spaceId: 'a', updatedAt: iso(3) })]
    expect(shape(list, 'space')).toEqual([
      ['空间 A', ['a1', 'a2']],
      ['空间 B', ['b1']],
      ['没关联空间', ['x']],
    ])
  })

  it('按需求：两个空间的同号需求不合并', () => {
    const list = [th('a', { spaceId: 'a', requirementId: 'REQ-001', requirementTitle: '登录' }), th('b', { spaceId: 'b', requirementId: 'REQ-001', requirementTitle: '导出' })]
    expect(shape(list, 'requirement')).toEqual([
      ['REQ-001 登录', ['a']],
      ['REQ-001 导出', ['b']],
    ])
  })

  it('按状态：待决定 / 出错 / 中断归到"需要你处理"，排在回复中之前', () => {
    const list = [th('r', { status: 'replying' }), th('n'), th('e', { status: 'error' }), th('p', { pendingProposals: 2 }), th('i', { status: 'interrupted' })]
    expect(shape(list, 'status')).toEqual([
      ['需要你处理', ['e', 'p', 'i']],
      ['回复中', ['r']],
      ['其他', ['n']],
    ])
  })
})
