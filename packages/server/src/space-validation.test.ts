import { expect, it } from 'vitest'
import { members } from './space.js'

it('成员 ID 非法时报"非法成员 ID"并说明规则，一次列出全部不合规的 ID', () => {
  const bad = [
    { id: 'demo-owner', name: 'Demo', role: 'owner' },
    { id: 'QA-admin-测试 成员', name: '测试', role: 'member' },
    { id: 'QA-admin-<b>x</b>&"\'', name: 'x', role: 'viewer' },
  ]
  expect(() => members(bad)).toThrow('非法成员 ID：QA-admin-测试 成员、QA-admin-<b>x</b>&"\'。成员 ID 只能用字母、数字和 . _ -，并以字母或数字开头；中文名请写在显示名（name）里')
  expect(() => members(bad)).not.toThrow(/需求/)
  expect(members([{ id: 'a.b_c-1', name: '张三', role: 'member' }])).toEqual([{ id: 'a.b_c-1', name: '张三', role: 'member' }])
})
