import { expect, it } from 'vitest'
import type { AttentionItem, RequirementSummary, SpaceMember } from '@taktflow/core'
import { assignedTo, assigneesOf, fallbackAssigneeOf, uncoveredDuties } from './attention-assign'

const item = (patch: Partial<AttentionItem>): AttentionItem => ({ requestId: 'a', runId: 'r', nodeId: 'n', requirementId: 'REQ-003', ask: '?', form: 'choice', createdAt: '', ...patch } as AttentionItem)
const owner: SpaceMember = { id: 'demo-owner', name: '示例负责人', role: 'owner' }
const rd: SpaceMember = { id: 'dev', name: '研发', role: 'member', duties: ['rd'] }
const reqs = [{ id: 'REQ-003', owner: 'demo-owner' }] as RequirementSummary[]

it('没有成员承担节点职责时回退给需求负责人（TF-044）', () => {
  const a = item({ owner: 'rd', assignees: [] })
  expect(assigneesOf(a, [owner], reqs)).toEqual({ ids: ['demo-owner'], fallback: true })
  expect(assignedTo(a, owner, [owner], reqs)).toBe(true)
})

it('有人承担职责或明确指派时照旧派给他们，不回退', () => {
  expect(assigneesOf(item({ owner: 'rd' }), [owner, rd], reqs)).toEqual({ ids: ['dev'], fallback: false })
  expect(assignedTo(item({ owner: 'rd' }), owner, [owner, rd], reqs)).toBe(false)
  expect(assigneesOf(item({ assignees: ['dev'] }), [owner], reqs)).toEqual({ ids: ['dev'], fallback: false })
  expect(assignedTo(item({ owner: 'rd' }), undefined, [owner], reqs)).toBe(false)
})

it('卡片文案：无人承担职责时给出职责和负责人名字（TF-044）', () => {
  expect(fallbackAssigneeOf(item({ owner: 'rd', assignees: [] }), [owner], reqs)).toEqual({ duty: 'rd', ownerId: 'demo-owner', ownerName: '示例负责人' })
  expect(fallbackAssigneeOf(item({ owner: 'rd' }), [owner, rd], reqs)).toBeUndefined()
  expect(fallbackAssigneeOf(item({ owner: 'rd', assignees: ['dev'] }), [owner], reqs)).toBeUndefined()
})

it('成员页列出没有成员承担的节点职责（TF-044）', () => {
  const items = [item({ requestId: 'a', owner: 'rd' }), item({ requestId: 'b', owner: 'qa' }), item({ requestId: 'c', owner: 'pm' })]
  expect(uncoveredDuties([owner, { id: 'pm', name: '产品', role: 'member', duties: ['pm'] }], items)).toEqual(['qa', 'rd'])
  expect(uncoveredDuties([rd], [])).toEqual([])
})
