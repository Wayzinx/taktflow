import { expect, it } from 'vitest'
import { stewardLinks } from './links.js'
import { requirementFile } from './files.js'

it('需求目录里的文件拆出需求和需求内路径，引用到产物页；其他文件不算', () => {
  expect(requirementFile('/s/shop', '/s/shop/requirements', 'requirements/REQ-003/reports/quality.md')).toEqual({ id: 'REQ-003', path: 'reports/quality.md' })
  expect(requirementFile('/s/shop', '/s/shop/.takt/workspaces', '.takt/workspaces/REQ-1/spec/prd.md')).toEqual({ id: 'REQ-1', path: 'spec/prd.md' })
  expect(requirementFile('/s/shop', '/s/shop/requirements', 'requirements/REQ-003')).toBeUndefined()
  expect(requirementFile('/s/shop', '/s/shop/requirements', 'agents/steward.md')).toBeUndefined()
  expect(stewardLinks.artifact('shop', 'REQ-003', 'reports/quality.md')).toBe('/s/shop/req/REQ-003?tab=artifacts&path=reports%2Fquality.md')
})
