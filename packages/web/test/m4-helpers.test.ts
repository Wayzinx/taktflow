import { describe, expect, it } from 'vitest'
import { uniqueAttachmentNames } from '../src/components/requirement-create/draft'
import { initialForm, toRequest } from '../src/components/space-create/model'
import { compactConfig } from '../src/pages/knowledge/schema-config'

// 真实后端联调里踩到的几处协议细节（见 packages/web 的 knownIssues）：都用纯函数兜住，这里锁住行为
describe('real-backend adapters', () => {
  it('attachment names avoid prd.md (reserved for the description) and case-insensitive duplicates', () => {
    expect(uniqueAttachmentNames(['prd.md', 'PRD.md', 'spec.md', 'spec.md', 'a b.md'])).toEqual(['prd-2.md', 'PRD-3.md', 'spec.md', 'spec-2.md', 'ab.md'])
    expect(uniqueAttachmentNames(['???'])).toEqual(['attachment'])
  })

  it('space creation lists the creator as owner unless members are copied from the source space', () => {
    const f = { ...initialForm(), id: 'lt', name: '联调' }
    expect(toRequest(f, { id: 'demo-owner', name: 'Demo' }).members).toEqual([{ id: 'demo-owner', name: 'Demo', role: 'owner' }])
    const copy = { ...f, start: 'copy' as const, copyFrom: 'chat-demo', parts: ['members' as const] }
    expect(toRequest(copy as never, { id: 'demo-owner', name: 'Demo' }).members).toBeUndefined()
  })

  it('knowledge config drops empty whitelists (the server treats [] as "allow none")', () => {
    expect(compactConfig({ driver: 'sqlite', connection: 'secret:x', tables: [], schemas: [], rowLimit: 50, sources: [] })).toEqual({ driver: 'sqlite', connection: 'secret:x', rowLimit: 50, sources: [] })
  })
})
