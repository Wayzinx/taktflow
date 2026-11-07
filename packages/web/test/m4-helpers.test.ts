import { describe, expect, it } from 'vitest'
import { descriptionOf, emptyDraft, titleOf, uniqueAttachmentNames } from '../src/components/requirement-create/draft'
import { initialForm, toRequest } from '../src/components/space-create/model'
import { compactConfig } from '../src/pages/knowledge/schema-config'

// 真实后端联调里踩到的几处协议细节（见 packages/web 的 knownIssues）：都用纯函数兜住，这里锁住行为
describe('real-backend adapters', () => {
  it('attachment names avoid prd.md (reserved for the description) and case-insensitive duplicates', () => {
    expect(uniqueAttachmentNames(['prd.md', 'PRD.md', 'spec.md', 'spec.md', 'a b.md'])).toEqual(['prd-2.md', 'PRD-3.md', 'spec.md', 'spec-2.md', 'ab.md'])
    expect(uniqueAttachmentNames(['???'])).toEqual(['attachment'])
  })

  it('the first line becomes the title and is not repeated as the first line of the description', () => {
    const d = { ...emptyDraft(), text: '\n导出支持按部门筛选\n\n背景：按部门对账\n目标：多选部门' }
    expect(titleOf(d)).toBe('导出支持按部门筛选')
    expect(descriptionOf(d)).toBe('背景：按部门对账\n目标：多选部门')
    // 手填标题时正文整段都是描述
    expect(descriptionOf({ ...d, title: '手填标题' })).toBe(d.text.trim())
    expect(descriptionOf({ ...emptyDraft(), text: '只有一行' })).toBe('')
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
