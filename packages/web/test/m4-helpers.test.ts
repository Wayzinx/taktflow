import { describe, expect, it } from 'vitest'
import { descriptionOf, emptyDraft, titleOf, uniqueAttachmentNames } from '../src/components/requirement-create/draft'
import { initialForm, toRequest } from '../src/components/space-create/model'
import { kbStatusMeta } from '../src/pages/knowledge/meta'
import { compactConfig } from '../src/pages/knowledge/schema-config'
import { layoutGhost, type Box } from '../src/pages/workflow/canvas/ghost-edits'
import { lit } from '../src/api/workflow-edit'

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

  it('a base that is "stale" only because a built candidate is unpublished reads 待发布, not 已过期', () => {
    expect(kbStatusMeta({ status: 'stale', version: 2, candidateVersion: 3, staleDocs: 0 }).label).toBe('待发布')
    expect(kbStatusMeta({ status: 'stale', version: 2, candidateVersion: 3, staleDocs: 1 }).label).toBe('已过期')
    expect(kbStatusMeta({ status: 'stale', version: 2 }).label).toBe('已过期')
    expect(kbStatusMeta({ status: 'stale', version: 2, candidateVersion: 3 }, true).label).toBe('构建中')
  })

  it('knowledge config drops empty whitelists (the server treats [] as "allow none")', () => {
    expect(compactConfig({ driver: 'sqlite', connection: 'secret:x', tables: [], schemas: [], rowLimit: 50, sources: [] })).toEqual({ driver: 'sqlite', connection: 'secret:x', rowLimit: 50, sources: [] })
  })
})

// 管家 workflow 提案的画布幽灵预览：新节点插在上下游之间并画出新旧依赖
describe('ghost preview layout', () => {
  // 同一列上下叠放：交付校验 → 人工准出
  const boxes: Record<string, Box> = { check: { x: 0, y: 0, w: 220, h: 60 }, accept: { x: 0, y: 110, w: 220, h: 60 }, other: { x: 400, y: 0, w: 220, h: 60 } }
  const boxOf = (id: string) => boxes[id]
  const needs: Record<string, string[]> = { accept: ['check'] }
  const needsOf = (id: string) => needs[id] ?? []

  it('an inserted node sits beside the gap between upstream and downstream, with edges in and out and the old edge crossed out', () => {
    const g = layoutGhost(
      [
        { op: 'addNode', kind: 'human', props: { id: lit('confirm'), title: lit('上线前人工确认'), needs: lit(['check']) }, after: 'check' },
        { op: 'setNeeds', id: 'accept', needs: ['confirm'] },
      ],
      boxOf,
      needsOf,
    )
    expect(g.added).toHaveLength(1)
    const box = g.added[0]!.box
    expect(box.x).toBeGreaterThan(220) // 列的右侧，不压住现有节点
    expect(box.y + box.h / 2).toBeCloseTo((60 + 110) / 2, 0) // 竖直居中在缝里
    expect(g.added[0]!.title).toBe('上线前人工确认')
    expect(g.links.filter((l) => l.tone === 'add').map((l) => l.key)).toEqual(['in-0-check', 'out-0-accept'])
    expect(g.links.filter((l) => l.tone === 'del').map((l) => l.key)).toEqual(['del-check-accept'])
    expect(g.changed.get('accept')?.keys).toEqual(['依赖'])
  })

  it('a node with no downstream sits right of its upstream; two ghosts in the same spot stack instead of overlapping', () => {
    const g = layoutGhost(
      [
        { op: 'addNode', kind: 'agent', props: { id: lit('a'), needs: lit(['check']) } },
        { op: 'addNode', kind: 'agent', props: { id: lit('b'), needs: lit(['check']) } },
      ],
      boxOf,
      needsOf,
    )
    const [a, b] = g.added.map((x) => x.box)
    expect(a!.y).toBe(0)
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.h)
    expect(g.links.every((l) => l.path.startsWith('M220,30'))).toBe(true)
  })

  it('a new dependency between existing nodes is drawn green, unknown ids are ignored', () => {
    const g = layoutGhost([{ op: 'setNeeds', id: 'accept', needs: ['check', 'other', 'ghost'] }], boxOf, needsOf)
    expect(g.links.map((l) => [l.key, l.tone])).toEqual([['new-other-accept', 'add']])
  })
})
