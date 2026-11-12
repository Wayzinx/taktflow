import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { StewardStore } from './store.js'
import { StewardAgent } from './agent.js'
import type { StewardDeps } from './contracts.js'
import type { StewardMessage, StewardStreamEvent } from '../api.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-threads-')); roots.push(root)
  const store = new StewardStore(join(root, 'steward/alice'))
  const thread = await store.createThread('原始标题', '2026-11-01T00:00:00Z')
  return { store, thread }
}
it('置顶排序、归档过滤、标题校验与手工标题持久化', async () => {
  const { store, thread } = await fixture()
  const newer = await store.createThread('较新', '2026-11-02T00:00:00Z')
  await store.patchThread(thread.id, { title: '  改名  ', pinned: true }, '2026-11-03T00:00:00Z')
  expect((await store.threads('', false)).map(t => t.id)).toEqual([thread.id, newer.id])
  await store.patchThread(newer.id, { pinned: true }, '2026-11-04T00:00:00Z')
  expect((await store.threads('', false))[0]!.id).toBe(newer.id)
  await store.patchThread(newer.id, { archived: true, pinned: false })
  expect((await store.threads('', false)).map(t => t.id)).toEqual([thread.id])
  expect((await store.threads('', true)).map(t => t.id)).toEqual([newer.id])
  await store.patchThread(newer.id, { archived: false })
  expect(await store.threads('', true)).toEqual([])
  for (const title of ['', ' ', '字'.repeat(81)]) await expect(store.patchThread(thread.id, { title })).rejects.toMatchObject({ status: 400 })
  await store.saveMessage({ id: 'u', threadId: thread.id, role: 'user', at: newer.createdAt, text: '不会覆盖标题' })
  expect(await store.thread(thread.id)).toMatchObject({ title: '改名', titleEdited: true, messageCount: 1 })
})
it('旧数据按需补算，消息修订不重复计数，实体引用参与归属', async () => {
  const { store, thread } = await fixture()
  const message: StewardMessage = { id: 'u', threadId: thread.id, role: 'user', text: '问题', at: thread.createdAt,
    context: [{ type: 'requirement', spaceId: 'shop', id: 'REQ-1', label: '订单' }] }
  await store.write(`threads/${thread.id}.json`, { ...thread, messageCount: undefined, context: [{ type: 'space', id: 'other' }] })
  await store.append(`threads/${thread.id}.jsonl`, message)
  expect(await store.thread(thread.id)).toMatchObject({ messageCount: 1, spaceId: 'shop', requirementId: 'REQ-1', requirementTitle: '订单' })
  await store.saveMessage({ ...message, text: '修订' })
  await store.saveMessage({ ...message, id: 'a', role: 'steward', context: [], blocks: [
    { type: 'entity', view: 'card', ref: { type: 'requirement', spaceId: 'new', id: 'REQ-2' }, snapshot: { title: '新需求', status: '还没开始', tone: 'neutral', at: thread.createdAt } },
    { type: 'entity', view: 'card', ref: { type: 'requirement', spaceId: 'new', id: 'REQ-2' }, snapshot: { title: '新需求', status: '还没开始', tone: 'neutral', at: thread.createdAt } },
  ] })
  expect(await store.thread(thread.id)).toMatchObject({ messageCount: 2, spaceId: 'new', requirementId: 'REQ-2', requirementTitle: '新需求' })
  expect(await store.read(`threads/${thread.id}.json`)).toMatchObject({ messageCount: 2 })
  const space = await store.createThread('空间', thread.createdAt, [{ type: 'space', id: 'solo' }])
  expect(space.spaceId).toBe('solo'); expect(space.requirementId).toBeUndefined()
})
it('pending 提案阻止删除，删除消息和元数据但保留动态', async () => {
  const { store, thread } = await fixture()
  await store.append('feed.jsonl', { threadId: thread.id })
  await store.write('proposals/p.json', { id: 'p', threadId: thread.id, status: 'pending' })
  await expect(store.deleteThread(thread.id)).rejects.toThrow('这个会话还有 1 个待决定的提案，先处理或归档')
  await store.write('proposals/p.json', { id: 'p', threadId: thread.id, status: 'rejected' })
  await store.deleteThread(thread.id)
  expect(await store.read(`threads/${thread.id}.json`)).toBeUndefined()
  expect(await store.lines(`threads/${thread.id}.jsonl`)).toEqual([])
  expect(await store.lines('feed.jsonl')).toEqual([{ threadId: thread.id }])
})
it('重启中断、回复失败、重试清理状态，按会话选择运行配置', async () => {
  const { store, thread } = await fixture()
  await store.setStatus(thread.id, 'replying')
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const deps: StewardDeps = { dataDir: () => store.dir, spaces: async () => [], open: async () => { throw new Error('不存在') },
    resolveRuntime: async (_prefs, runtime) => {
      expect(runtime).toEqual({ harness: 'native', model: 'chosen' })
      return { chat: async () => { await gate; throw new Error('模型未安装，请检查配置') } }
    } }
  const agent = new StewardAgent(deps, 'alice')
  try {
    await agent.ready
    expect((await store.thread(thread.id)).status).toBe('interrupted')
    await store.patchThread(thread.id, { runtime: { harness: 'native', model: 'chosen' } })
    const posted = await agent.post({ text: '继续' }, thread.id)
    expect((await store.thread(thread.id)).status).toBe('replying')
    finish(); await posted.done
    expect(await store.thread(thread.id)).toMatchObject({ status: 'error', error: '模型未安装，请检查配置' })
    deps.resolveRuntime = async () => ({ run: async turn => {
      const current = await store.thread(thread.id)
      expect(current.status).toBe('replying'); expect(current.error).toBeUndefined()
      // takt 自己的工具经 MCP 回到 turn.call，harness 事件里同一次调用不能再记一遍；harness 自带的工具照记
      turn.onEvent({ type: 'message', role: 'assistant', text: '先查一下空间。' })
      await turn.call('list_spaces', {})
      turn.onEvent({ type: 'tool_call', callId: 'c', tool: 'mcp__takt__list_spaces', input: '{}', ok: true })
      turn.onEvent({ type: 'tool_call', callId: 'r', tool: 'Read', input: '{"path":"README.md"}', ok: true })
      turn.onEvent({ type: 'message', role: 'assistant', text: '完成' })
      return '完成'
    } })
    const events: StewardStreamEvent[] = [], off = store.onThread(thread.id, event => events.push(event))
    const reply = await agent.ask({ text: '重试' }, thread.id)
    off()
    expect(reply).toMatchObject({ status: 'done', text: '完成', thinking: '先查一下空间。', offline: false, tools: [{ tool: 'list_spaces' }, { tool: 'Read' }] })
    expect(reply.tools).toHaveLength(2)
    // 调过工具后再开口：前面的过程说明挪进思考摘要，正文先清空再接上回答
    expect(events).toContainEqual(expect.objectContaining({ type: 'thinking', text: '先查一下空间。' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'delta', text: '', reset: true }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'delta', text: '完成' }))
    // 流式开始时还不知道是不是规则回复，不能先挂上「规则回复」
    expect(events.find((e) => e.type === 'message' && e.message.role === 'steward')).not.toMatchObject({ message: { offline: true } })
    expect((await store.thread(thread.id)).status).toBeUndefined()
    await store.patchThread(thread.id, { runtime: null })
    expect((await store.thread(thread.id)).runtime).toBeUndefined()
  } finally { agent.close() }
})
it('标题超过 20 字带省略号；摘要去掉 Markdown；上下文标签只是编号时去查真实标题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-threads-')); roots.push(root)
  const store = new StewardStore(join(root, 'steward/alice'), async (space, id) => (space === 'std' && id === 'REQ-001' ? '问候语支持空名字' : undefined))
  expect((await store.createThread('standard-delivery 有哪些需求？各自什么状态', '2026-11-01T00:00:00Z')).title).toBe('standard-delivery 有哪…')
  const thread = await store.createThread('短\n标题', '2026-11-01T00:00:00Z', [{ type: 'requirement', spaceId: 'std', id: 'REQ-001', label: 'REQ-001' }])
  expect(thread).toMatchObject({ title: '短 标题', requirementId: 'REQ-001', requirementTitle: '问候语支持空名字' })
  const text = '失败在 **clarify（需求澄清）** 节点 [1]，可以[重新生成「交付 Agent」提案](/steward?thread=2b4e)。\n\n| 编号 | 状态 |\n| --- | --- |\n| REQ-1 | 已交付 |\n\n```json\n{"a":1}\n```'
  await store.saveMessage({ id: 's', threadId: thread.id, role: 'steward', at: thread.createdAt, text })
  expect((await store.thread(thread.id)).lastMessage).toBe('失败在 clarify（需求澄清） 节点 [1]，可以重新生成「交付 Agent」提案。 编号 状态 REQ-1 已交付 {"a":1}')
})

it('已补过消息数的历史会话仍能回填真实需求标题，不把编号重复当标题', async () => {
  const { store, thread } = await fixture()
  await store.write(`threads/${thread.id}.json`, { ...thread, messageCount: 2, spaceId: 'shop', requirementId: 'REQ-001', requirementTitle: 'REQ-001' })
  const hydrated = new StewardStore(store.dir, async () => '问候语支持空名字')
  expect(await hydrated.thread(thread.id)).toMatchObject({ requirementId: 'REQ-001', requirementTitle: '问候语支持空名字', messageCount: 2 })
  expect(await hydrated.read(`threads/${thread.id}.json`)).toMatchObject({ requirementTitle: '问候语支持空名字' })
})
