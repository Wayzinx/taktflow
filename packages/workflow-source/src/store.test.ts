import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor, WorkflowChangedEvent } from '@taktflow/core'
import { sha256 } from '@taktflow/core'
import { createWorkflowStore } from './index.js'
import type { WorkflowStore, WorkflowWriteResult } from './index.js'
import { workflowFixture } from './test-fixtures.js'

let dir: string
let workflows: string
let history: string
let file: string
let store: WorkflowStore
const stops: Array<() => Promise<void>> = []
const author: Actor = { type: 'human', id: 'alice' }
const literal = (value: unknown) => ({ kind: 'literal' as const, value })
function document(result: WorkflowWriteResult) {
  if ('error' in result) throw new Error(JSON.stringify(result))
  return result
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'takt-workflow-store-'))
  workflows = join(dir, 'workflows'); history = join(dir, 'history'); file = join(workflows, 'sample.workflow.ts')
  await mkdir(workflows)
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(file, workflowFixture)
  store = createWorkflowStore({ dir: workflows, historyDir: history })
})
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()))
  await rm(dir, { recursive: true, force: true })
})

describe('workflow 存储', () => {
  it('按源码 id 列出、读取完整文档，初始修订保留原文', async () => {
    const list = await store.list()
    expect(list).toEqual([expect.objectContaining({ id: 'demo', title: 'Demo', file: 'workflows/sample.workflow.ts', nodes: 2, runs: 0, rev: sha256(workflowFixture), editable: true })])
    const doc = await store.get('demo')
    expect(doc.snapshot?.id).toBe('demo')
    expect(doc.layout).toEqual({ nodes: {} })
    expect(doc.diagnostics).toEqual([])
    expect(await readFile(join(history, 'demo', `${doc.rev}.ts`), 'utf8')).toBe(workflowFixture)
    expect(await store.revisions('demo')).toHaveLength(1)
    await store.get('demo')
    expect(await store.revisions('demo')).toHaveLength(1)
  })
  it('列表带 useWhen，以及经“新建流程”创建时的作者与原因（Lead 自建的流程能被认出来）', async () => {
    const lead: Actor = { type: 'agent', role: 'lead', harness: 'dsh', onBehalfOf: 'alice' }
    expect((await store.list())[0]).not.toHaveProperty('createdBy')
    const source = workflowFixture.replace("id: 'demo'", "id: 'lite'").replace("version: '1',", "version: '1',\n  useWhen: '单个模块的小改动',")
    document(await store.create('lite', { source, author: lead, reason: '用户：小改动走短流程' }))
    const lite = (await store.list()).find((item) => item.id === 'lite')
    expect(lite).toMatchObject({ useWhen: '单个模块的小改动', createdBy: { author: lead, reason: '用户：小改动走短流程', at: expect.any(String) } })
  })
  it('缺少 id 时回退文件名；坏源码仍可读取诊断', async () => {
    await writeFile(file, 'export default other')
    expect((await store.list())[0]).toMatchObject({ id: 'sample', editable: false })
    expect((await store.get('sample')).diagnostics[0]?.severity).toBe('error')
  })
  it('保存、修订、统一 diff 和回滚记录真实父修订', async () => {
    const original = await store.get('demo')
    const saved = document(await store.edit('demo', { baseRev: original.rev, edits: [{ op: 'setProp', id: 'a', key: 'prompt', value: literal('edited') }], author, reason: '更新提示词' }))
    expect(saved.source).toBe(workflowFixture.replace("prompt: 'first'", "prompt: 'edited'"))
    expect(await readFile(file, 'utf8')).toBe(saved.source)
    const detail = await store.revision('demo', saved.rev)
    expect(detail.revision).toMatchObject({ parent: original.rev, author, reason: '更新提示词', summary: '修改 a.prompt' })
    expect(detail.diff).toContain("-      prompt: 'first',")
    expect(detail.diff).toContain("+      prompt: 'edited',")
    const rollback = document(await store.rollback('demo', original.rev, author, '恢复'))
    expect(rollback.source).toBe(original.source)
    expect((await store.revisions('demo')).at(-1)).toMatchObject({ rev: original.rev, parent: saved.rev, reason: '恢复' })
    expect((await store.revision('demo', original.rev)).diff).toContain("+      prompt: 'first',")
  })
  it('不同节点的过期编辑三方合并；同一属性返回冲突且不落盘', async () => {
    const base = await store.get('demo')
    const first = document(await store.edit('demo', { baseRev: base.rev, edits: [{ op: 'setProp', id: 'a', key: 'prompt', value: literal('alice') }], author }))
    const merged = document(await store.edit('demo', { baseRev: base.rev, edits: [{ op: 'setProp', id: 'b', key: 'prompt', value: literal('bob') }], author: { type: 'human', id: 'bob' } }))
    expect(merged.source).toBe(first.source.replace("prompt: 'second'", "prompt: 'bob'"))
    const conflict = await store.edit('demo', { baseRev: base.rev, edits: [{ op: 'setProp', id: 'a', key: 'prompt', value: literal('conflicting') }], author })
    expect(conflict).toMatchObject({ error: 'conflict', base: base.source, ours: merged.source, currentRev: merged.rev })
    if ('error' in conflict && conflict.error === 'conflict') expect(conflict.merged).toContain('||||||| base')
    expect(await readFile(file, 'utf8')).toBe(merged.source)
    expect(await store.revisions('demo')).toHaveLength(3)
  })
  it('replaceSource 过期源码也合并', async () => {
    const base = await store.get('demo')
    await store.replaceSource('demo', { baseRev: base.rev, source: base.source.replace("prompt: 'first'", "prompt: 'left'"), author })
    const merged = document(await store.replaceSource('demo', { baseRev: base.rev, source: base.source.replace("prompt: 'second'", "prompt: 'right'"), author }))
    expect(merged.source).toContain("prompt: 'left'")
    expect(merged.source).toContain("prompt: 'right'")
  })
  it('同进程两个 store 并发写入不会丢改动', async () => {
    const second = createWorkflowStore({ dir: workflows, historyDir: history })
    const base = await store.get('demo')
    const results = await Promise.all([
      store.edit('demo', { baseRev: base.rev, edits: [{ op: 'setProp', id: 'a', key: 'prompt', value: literal('left') }], author }),
      second.edit('demo', { baseRev: base.rev, edits: [{ op: 'setProp', id: 'b', key: 'prompt', value: literal('right') }], author }),
    ])
    results.forEach(document)
    expect(await readFile(file, 'utf8')).toBe(base.source.replace("prompt: 'first'", "prompt: 'left'").replace("prompt: 'second'", "prompt: 'right'"))
  })
  it('校验失败、未知基线、id 改名均不写入', async () => {
    const base = await store.get('demo')
    for (const source of [base.source.replace("prompt: 'first'", 'prompt: =>'), base.source.replace("prompt: 'first',", "prompt: 'first', needs: ['missing'],"), base.source.replace("id: 'demo'", "id: 'renamed'")]) {
      const result = await store.replaceSource('demo', { baseRev: base.rev, source, author })
      expect(result).toMatchObject({ error: 'validation', diagnostics: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]) })
      expect(await readFile(file, 'utf8')).toBe(base.source)
    }
    await expect(store.edit('demo', { baseRev: '0'.repeat(64), edits: [], author })).rejects.toThrow('修订不存在')
    expect(await store.revisions('demo')).toHaveLength(1)
    expect(await readdir(workflows)).toEqual(['sample.workflow.ts'])
  })
  it('布局旁路读回，删除节点和源码替换均清理布局', async () => {
    const base = await store.get('demo')
    const layout = { nodes: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }, viewport: { x: 0, y: 0, zoom: 1 } }
    expect(await store.setLayout('demo', layout)).toEqual(layout)
    expect(await store.getLayout('demo')).toEqual(layout)
    const saved = document(await store.edit('demo', { baseRev: base.rev, edits: [{ op: 'removeNode', id: 'a' }], author }))
    expect(saved.layout).toEqual({ ...layout, nodes: { b: layout.nodes.b } })
    expect(JSON.parse(await readFile(join(workflows, 'demo.layout.json'), 'utf8'))).toEqual(saved.layout)
    expect((await store.get('demo')).layout).toEqual(saved.layout)
  })
  it('watch 捕获订阅后立即外部写入，记录声明作者且只消费一次', async () => {
    const events: WorkflowChangedEvent[] = []
    const errors: unknown[] = []
    const actor: Actor = { type: 'agent', role: 'dev', harness: 'test' }
    store.expectExternalChange('demo', actor)
    stops.push(store.watch((event) => events.push(event), (error) => errors.push(error)))
    await writeFile(file, workflowFixture.replace("prompt: 'first'", "prompt: 'external-1'"))
    await expect.poll(() => events.length, { timeout: 5000 }).toBe(1)
    expect(events[0]?.revision.author).toEqual(actor)
    expect(events[0]?.revision.parent).toBe(sha256(workflowFixture))
    await writeFile(file, workflowFixture.replace("prompt: 'first'", "prompt: 'external-2'"))
    await expect.poll(() => events.length, { timeout: 5000 }).toBe(2)
    expect(events[1]?.revision.author).toEqual({ type: 'agent', role: 'unknown', harness: 'external' })
    expect((await store.revisions('demo'))).toHaveLength(3)
    expect(errors).toEqual([])
  }, 10_000)
  it('watch 不把本包保存重复记为外部修改；可关闭所有轮询', async () => {
    const base = await store.get('demo')
    const events: WorkflowChangedEvent[] = []
    const errors: unknown[] = []
    const stop = store.watch((event) => events.push(event), (error) => errors.push(error))
    stops.push(stop)
    const saved = document(await store.edit('demo', { baseRev: base.rev, edits: [{ op: 'setMeta', key: 'title', value: 'new' }], author }))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(events).toEqual([expect.objectContaining({ workflowId: 'demo', revision: expect.objectContaining({ rev: saved.rev, author }) })])
    await stop()
    await writeFile(file, workflowFixture)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(events).toHaveLength(1)
    expect(errors).toEqual([])
  }, 10_000)
  it('外部坏源码仍记录历史和事件，get 返回诊断', async () => {
    const events: WorkflowChangedEvent[] = []
    await store.get('demo')
    stops.push(store.watch((event) => events.push(event)))
    await writeFile(file, workflowFixture.replace("prompt: 'first',", "prompt: 'first', needs: ['missing'],"))
    await expect.poll(() => events.length, { timeout: 5000 }).toBe(1)
    expect((await store.get('demo')).diagnostics.some((d) => d.severity === 'error')).toBe(true)
  })
  it('list 发出的基线也可用于后续外部修改后的合并', async () => {
    const base = (await store.list())[0]!
    await writeFile(file, workflowFixture.replace("prompt: 'first'", "prompt: 'outside'"))
    const result = document(await store.edit('demo', { baseRev: base.rev, edits: [{ op: 'setProp', id: 'b', key: 'prompt', value: literal('request') }], author }))
    expect(result.source).toContain("prompt: 'outside'")
    expect(result.source).toContain("prompt: 'request'")
  })
  it('校验期间外部修改会重新合并，保留双方内容', async () => {
    const base = await store.get('demo')
    const proposed = "await new Promise((resolve) => setTimeout(resolve, 250))\n" + base.source.replace("prompt: 'first'", "prompt: 'requested'")
    const saving = store.replaceSource('demo', { baseRev: base.rev, source: proposed, author })
    await expect.poll(async () => (await readdir(workflows)).some((name) => name.startsWith('.workflow-validation-')), { timeout: 3000 }).toBe(true)
    await writeFile(file, base.source.replace("prompt: 'second'", "prompt: 'external'") )
    const saved = document(await saving)
    expect(saved.source).toContain("prompt: 'requested'")
    expect(saved.source).toContain("prompt: 'external'")
    expect((await store.revisions('demo')).at(-2)?.author).toEqual({ type: 'agent', role: 'unknown', harness: 'external' })
    expect((await readdir(workflows)).some((name) => name.startsWith('.workflow-validation-'))).toBe(false)
  })
  it('拒绝路径穿越和重复 workflow id', async () => {
    await expect(store.revisions('../outside')).rejects.toThrow('非法 workflow id')
    await expect(store.revision('demo', '../outside')).rejects.toThrow('非法修订')
    await writeFile(join(workflows, 'duplicate.workflow.ts'), workflowFixture)
    await expect(store.list()).rejects.toThrow('id 重复')
  })
})
