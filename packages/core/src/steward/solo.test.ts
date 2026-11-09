import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { KnowledgeStore } from '../interfaces.js'
import type { KnowledgeBase, RunState, WorkflowSnapshot } from '../types.js'
import type { StewardBlock, StewardContextRef, StewardPrefs, WorkflowDocument } from '../api.js'
import { StewardAgent } from './agent.js'
import { normalizeBlocks, describeBlocks } from './blocks.js'
import { StewardError, type StewardDeps, type StewardSpace } from './contracts.js'
import { entityRun, entitySnapshot, resolveEntityRef } from './entity.js'
import { findEntities } from './find.js'
import { stewardPicks } from './picks.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const now = '2026-11-09T12:00:00.000Z'
const prefs: StewardPrefs = { trust: 'confirm', digestTimes: [] }
const workflow: WorkflowSnapshot = { id: 'delivery', title: '标准交付', version: '1', stages: [{ id: 'dev', title: '研发测试' }], nodes: [{ id: 'judge', title: '失败判决', kind: 'judge', stage: 'dev', needs: [], harness: 'codex' }] }

async function fixture(ids = ['shop']) {
  const root = await mkdtemp(join(tmpdir(), 'takt-solo-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const spaces = new Map<string, StewardSpace>()
  for (const id of ids) {
    const stores = await initProject(join(root, id), { name: `${id}商店` })
    const doc: WorkflowDocument = { id: workflow.id, file: 'delivery.workflow.ts', rev: 'rev', source: '', diagnostics: [], layout: { nodes: {} }, snapshot: workflow,
      model: { editable: true, meta: { id: workflow.id, title: { kind: 'literal', value: workflow.title }, version: { kind: 'literal', value: '1' } }, stages: { kind: 'literal', value: workflow.stages }, nodes: [] } }
    spaces.set(id, { id, name: `${id}商店`, dir: stores.projectDir, stores, commands: { list: () => [], run: async () => { throw new Error('本夹具不执行写命令') } },
      workflows: { list: async () => [{ id: workflow.id, title: workflow.title, file: doc.file, rev: doc.rev, editable: true, updatedAt: now, nodes: 1, runs: 0 }], get: async id => { if (id !== workflow.id) throw new StewardError(404, '流程不存在，请重新选择'); return doc }, rollback: async () => {} },
      postToLead: async () => '', onChat: () => () => {} })
  }
  const visible = [...ids]
  const deps: StewardDeps = { dataDir: user => join(root, '.steward', user), now: () => new Date(now), spaces: async () => visible.map(id => ({ id, name: spaces.get(id)!.name, requirements: 0, active: 0 })), open: async id => { if (!visible.includes(id)) throw new StewardError(403, '空间不可见，请联系管理员'); return spaces.get(id)! } }
  const agent = new StewardAgent(deps, 'alice'); await agent.ready
  cleanup.push(async () => { await agent.drain(); agent.close() })
  const add = async (spaceId: string, id = 'REQ-002', title = '订单导出报表支持 CSV', status?: RunState['status'], at = now, runId = 'run-0002') => {
    const space = spaces.get(spaceId)!
    const req = await space.stores.workspaces.createRequirement({ id, title })
    await writeFile(join(space.stores.workspaces.dir(id), 'requirement.json'), JSON.stringify({ ...req, createdAt: at, updatedAt: at }))
    if (status) {
      const run: RunState = { runId, requirementId: id, workflowId: workflow.id, workflowVersion: '1', status, startedAt: at, ...(status === 'succeeded' ? { endedAt: at } : {}), nodes: { judge: { id: 'judge', status, attempts: 1, outputs: [] } }, args: {}, expansions: [] }
      await space.stores.runs.create(run, workflow)
    }
    return { space, ref: { type: 'requirement' as const, spaceId, id } }
  }
  return { spaces, visible, deps, agent, add }
}

function blockContext(deps: StewardDeps) {
  return { resolveRef: (ref: StewardContextRef) => resolveEntityRef(deps, ref), snapshot: async (ref: StewardContextRef) => entitySnapshot(await deps.open(ref.spaceId!), ref, now), focusVisible: async (ref: StewardContextRef, focus: string) => (await entityRun(await deps.open(ref.spaceId!), ref.id)).graph.nodes.some(node => node.id === focus) }
}

describe('Solo 快照', () => {
  it.each([
    [undefined, '还没开始', 'neutral'], ['running', '研发测试 · 失败判决在跑', 'running'], ['waiting_human', '研发测试 · 失败判决等你确认', 'waiting'], ['failed', '研发测试 · 失败判决失败', 'failed'], ['cancelled', '研发测试 · 失败判决已取消', 'failed'], ['succeeded', '已交付', 'success'],
  ] as const)('%s 的需求人话与颜色', async (status, expected, tone) => {
    const f = await fixture(), { space, ref } = await f.add('shop', undefined, undefined, status)
    const result = await entitySnapshot(space, ref, now)
    expect(result).toMatchObject({ title: '订单导出报表支持 CSV', status: expected, tone, at: now })
    if (status === 'waiting_human') expect(result.stages).toEqual([{ label: '研发测试', status: 'waiting' }])
    expect(result).not.toHaveProperty('summary')
  })
  it('待办优先、Lead 临时任务不覆盖阶段，归档保留状态', async () => {
    const f = await fixture(), { space, ref } = await f.add('shop', undefined, undefined, 'running')
    const original = (await space.stores.runs.get('run-0002'))!
    await space.stores.runs.create({ ...original, runId: 'task-0003', kind: 'task', startedAt: '2026-11-09T13:00:00Z', status: 'succeeded' }, workflow)
    await space.stores.attention.create({ requestId: 'ask', requirementId: ref.id, runId: original.runId, nodeId: 'judge', ask: '金额保留几位？', form: 'answer' })
    expect(await entitySnapshot(space, ref)).toMatchObject({ status: '研发测试 · 等你确认', tone: 'waiting', summary: '1 件等你决定' })
    expect(await entitySnapshot(space, { type: 'space', id: space.id })).toMatchObject({ title: 'shop商店', status: '1 个进行中 · 1 件等你', tone: 'waiting' })
    await space.stores.workspaces.updateRequirement(ref.id, { status: 'archived' })
    expect(await entitySnapshot(space, ref)).toMatchObject({ status: '已归档', tone: 'waiting' })
  })
  it('运行和节点读取图、实际 harness 与 activity', async () => {
    const f = await fixture(), { space } = await f.add('shop', undefined, undefined, 'running')
    const run = (await space.stores.runs.get('run-0002'))!
    run.nodes.judge!.sessionRef = { harness: 'native', sessionId: 'session' }; await space.stores.runs.save(run)
    await space.stores.events.append(run.runId, { type: 'node.started', actor: { type: 'system', id: 'test' }, nodeId: 'judge', data: { attempt: 1 } })
    await space.stores.events.append(run.runId, { type: 'harness.tool_call', actor: { type: 'system', id: 'test' }, nodeId: 'judge', data: { phase: 'start', callId: 'tool-1', tool: 'npm test', input: 'npm test' } })
    expect(await entitySnapshot(space, { type: 'run', id: run.runId })).toMatchObject({ title: '标准交付 · run-0002', status: '失败判决在跑', stages: [{ status: 'running' }] })
    expect(await entitySnapshot(space, { type: 'node', id: 'judge', parent: run.runId })).toMatchObject({ title: '失败判决', status: '在跑 · native · 正在执行 npm test' })
    await expect(entitySnapshot(space, { type: 'node', id: 'judge' })).rejects.toMatchObject({ status: 400 })
  })
  it('运行总状态还在跑时，等人叶节点仍显示 waiting；全跳过不算已交付', async () => {
    const f = await fixture(), { space, ref } = await f.add('shop', undefined, undefined, 'running')
    const run = (await space.stores.runs.get('run-0002'))!
    run.nodes.judge!.status = 'waiting_human'; await space.stores.runs.save(run)
    expect(await entitySnapshot(space, ref)).toMatchObject({ tone: 'waiting' })
    expect(await entitySnapshot(space, { type: 'run', id: run.runId })).toMatchObject({ tone: 'waiting' })
    run.status = 'succeeded'; run.nodes.judge!.status = 'skipped'; await space.stores.runs.save(run)
    const snapshot = await entitySnapshot(space, ref)
    expect(snapshot.status).toContain('尚未交付'); expect(snapshot.tone).toBe('running')
  })
  it('动态展开节点可读，并且在对应运行图中校验', async () => {
    const f = await fixture(), { space } = await f.add('shop', undefined, undefined, 'running')
    const run = (await space.stores.runs.get('run-0002'))!
    run.expansions.push({ plannerId: 'judge', items: [], nodeIds: ['dynamic/task'], at: now, nodes: [{ id: 'dynamic/task', title: '动态任务', kind: 'agent', needs: [] }] })
    run.nodes['dynamic/task'] = { id: 'dynamic/task', status: 'running', attempts: 1, outputs: [] }
    await space.stores.runs.save(run)
    expect(await resolveEntityRef(f.deps, { type: 'node', id: 'dynamic/task', parent: run.runId })).toMatchObject({ spaceId: 'shop' })
  })
})

describe('Solo 块校验', () => {
  it('补齐唯一空间，删除伪造 snapshot 和非法 focus，摘要供模型引用', async () => {
    const f = await fixture(); await f.add('shop', undefined, undefined, 'running')
    const result = await normalizeBlocks([
      { type: 'entity', view: 'card', ref: { type: 'requirement', id: 'REQ-002' }, snapshot: { title: '伪造', status: '已交付' } },
      { type: 'entity', view: 'dag', ref: { type: 'run', id: 'run-0002' }, focus: 'missing' },
      { type: 'entity', view: 'dag', ref: { type: 'run', id: 'run-0002' }, focus: 'judge' },
    ], blockContext(f.deps))
    expect(result.blocks[0]).toMatchObject({ ref: { spaceId: 'shop' }, snapshot: { title: '订单导出报表支持 CSV', tone: 'running' } })
    expect(result.blocks[1]).not.toHaveProperty('focus')
    expect(result.blocks[2]).toMatchObject({ focus: 'judge' })
    expect(result.issues.join()).toContain('focus')
    expect(describeBlocks(result.blocks)[0]).toMatch(/^REQ-002「订单导出报表支持 CSV」：研发测试.*（shop · 需求卡）$/)
  })
  it('空间不唯一、不可见、类型不匹配、节点缺 parent 都丢弃', async () => {
    const f = await fixture(['shop', 'other', 'secret']); await f.add('shop'); await f.add('other'); await f.add('secret'); f.visible.pop()
    const result = await normalizeBlocks([
      { type: 'entity', view: 'card', ref: { type: 'requirement', id: 'REQ-002' } },
      { type: 'entity', view: 'card', ref: { type: 'requirement', id: 'REQ-002', spaceId: 'secret' } },
      { type: 'entity', view: 'dag', ref: { type: 'requirement', id: 'REQ-002', spaceId: 'shop' } },
      { type: 'entity', view: 'node', ref: { type: 'node', id: 'judge', spaceId: 'shop' } },
      { type: 'entity', view: 'stages', ref: { type: 'space', id: 'shop' } },
      { type: 'entity', view: 'card', ref: { type: 'requirement', id: 'missing', spaceId: 'shop' } },
    ], blockContext(f.deps))
    expect(result.blocks).toEqual([]); expect(result.issues.length).toBeGreaterThanOrEqual(6)
    expect(result.issues.join()).toContain('view 与 ref 类型不匹配')
  })
  it('实体最多三块、pick 最多一块，候选去重且限制 2–5 个', async () => {
    const f = await fixture(); const refs = []
    for (let i = 1; i <= 7; i++) refs.push((await f.add('shop', `REQ-${i}`)).ref)
    const entity = { type: 'entity', view: 'card', ref: refs[0] }
    const pick = { type: 'pick', items: refs.map(ref => ({ ref, snapshot: { title: '伪造' } })) }
    const result = await normalizeBlocks([entity, entity, entity, entity, pick, pick], blockContext(f.deps))
    expect(result.blocks.map(block => block.type)).toEqual(['entity', 'entity', 'entity', 'pick'])
    const block = result.blocks[3] as Extract<StewardBlock, { type: 'pick' }>
    expect(block.items).toHaveLength(5); expect(block.items[0]?.snapshot.title).not.toBe('伪造')
    expect(describeBlocks([block])[0]).toContain('你说的是哪一个')
    for (const items of [[{ ref: refs[0] }], [{ ref: refs[0] }, { ref: refs[0] }], [{ ref: refs[0] }, { ref: { type: 'requirement', id: 'missing' } }]]) {
      expect((await normalizeBlocks([{ type: 'pick', items }], blockContext(f.deps))).blocks).toEqual([])
    }
  })
  it('show 分次追加仍受整条消息上限约束，issues 回给模型并持久化', async () => {
    const f = await fixture(); const { ref } = await f.add('shop')
    let round = 0
    const outputs: unknown[] = []
    f.deps.chat = async request => {
      outputs.push(...request.messages.filter(message => message.role === 'tool').map(message => message.content))
      round++
      if (round <= 4) return { stopReason: 'tool_calls', message: { role: 'assistant', content: '', toolCalls: [{ id: `call-${round}`, name: 'show', arguments: JSON.stringify({ blocks: [{ type: 'entity', view: 'card', ref }] }) }] } }
      return { stopReason: 'end', message: { role: 'assistant', content: '还没开始。' } }
    }
    const answer = await f.agent.ask({ text: '看进度', context: [ref] })
    expect(answer.status, answer.error).toBe('done'); expect(answer.blocks).toHaveLength(3)
    expect(JSON.stringify(outputs)).toContain('最多 3 个 entity')
    const saved = (await f.agent.store.messages(answer.threadId)).find(item => item.id === answer.id)!
    expect(saved.blocks).toEqual(answer.blocks)
  })
})

describe('Solo 查找', () => {
  it.each(['REQ-002', 'req-002', 'REQ 2', 'req-02', 'REQ-003', '导出报表那个到哪了', '订单报表'])('查询 %s 命中需求并附真实快照', async q => {
    const f = await fixture(); await f.add('shop')
    const result = await findEntities(f.deps, { q, types: ['requirement'] }, prefs)
    expect(result.items[0]).toMatchObject({ ref: { spaceId: 'shop', id: 'REQ-002' }, snapshot: { title: '订单导出报表支持 CSV' } })
    expect(result.items[0]?.why).toMatch(/命中|相差|标题/)
    expect(result.items[0]?.why).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
  it('精确优于错字和标题，尾号命中运行', async () => {
    const f = await fixture(); await f.add('shop', undefined, undefined, 'running'); await f.add('shop', 'REQ-003', '另一个报表')
    const result = await findEntities(f.deps, { q: 'REQ 2', types: ['requirement'] }, prefs)
    expect(result.items.map(item => item.ref.id)).toEqual(['REQ-002', 'REQ-003']); expect(result.ambiguous).toBe(false)
    expect((await findEntities(f.deps, { q: '0002', types: ['run'] }, prefs)).items[0]?.ref.id).toBe('run-0002')
    expect((await findEntities(f.deps, { q: 'RUN-0002' }, prefs)).items[0]?.match).toBe('id')
  })
  it('已归档的需求只按编号找，不和在做的需求抢成歧义', async () => {
    const f = await fixture(); await f.add('shop')
    const old = await f.add('shop', 'REQ-001', '订单导出报表旧版'); await old.space.stores.workspaces.updateRequirement('REQ-001', { status: 'archived' })
    const result = await findEntities(f.deps, { q: '导出报表', types: ['requirement'] }, prefs)
    expect(result.items.map(item => item.ref.id)).toEqual(['REQ-002']); expect(result.ambiguous).toBe(false)
    expect((await findEntities(f.deps, { q: 'REQ-001', types: ['requirement'] }, prefs)).items[0]?.snapshot.status).toBe('已归档')
  })
  it('同名跨空间歧义、context 加权、静音和访问范围、limit=1 仍报告歧义', async () => {
    const f = await fixture(['shop', 'other', 'secret']); for (const id of f.visible) await f.add(id)
    f.visible.pop()
    expect((await findEntities(f.deps, { q: '导出报表', limit: 1 }, prefs)).ambiguous).toBe(true)
    const result = await findEntities(f.deps, { q: '导出报表' }, prefs, [{ type: 'requirement', spaceId: 'other', id: 'REQ-002' }])
    expect(result.items[0]?.ref.spaceId).toBe('other'); expect(result.items).toHaveLength(2)
    expect((await findEntities(f.deps, { q: 'REQ-002' }, { ...prefs, mutedSpaces: ['shop'] })).items.map(item => item.ref.spaceId)).toEqual(['other'])
    expect((await findEntities(f.deps, { q: 'REQ-002', spaceId: 'secret' }, prefs)).items).toEqual([])
    expect((await findEntities(f.deps, { q: 'REQ-002', spaceId: 'shop' }, prefs)).items).toHaveLength(1)
  })
  it('节点只在命中需求的最近流水线中找，workflow、知识库按编号和标题找', async () => {
    const f = await fixture(); const { space } = await f.add('shop', undefined, undefined, 'running')
    const old = (await space.stores.runs.get('run-0002'))!
    await space.stores.runs.create({ ...old, runId: 'run-0001', startedAt: '2026-11-08T12:00:00Z' }, workflow)
    expect((await findEntities(f.deps, { q: 'REQ-002 失败判决', types: ['node'] }, prefs)).items.map(item => item.ref.parent)).toEqual(['run-0002'])
    expect((await findEntities(f.deps, { q: '失败判决', types: ['node'] }, prefs)).items).toEqual([])
    expect((await findEntities(f.deps, { q: 'judge', types: ['node'] }, prefs, [{ type: 'requirement', id: 'REQ-002', spaceId: 'shop' }])).items[0]?.ref.id).toBe('judge')
    const base: KnowledgeBase = { id: 'delivery-guide', name: '交付指南', kind: 'rag', description: '', intents: [], scope: 'space', config: {}, retrieval: { topK: 8, budgetTokens: 4000 }, status: 'ready', version: 1, createdAt: now, updatedAt: now, createdBy: { type: 'human', id: 'alice' } }
    space.stores.kb = { list: async () => [base], get: async id => id === base.id ? base : undefined } as KnowledgeStore
    for (const q of ['delivery', '标准交付']) expect((await findEntities(f.deps, { q, types: ['workflow'] }, prefs)).items[0]?.snapshot.title).toBe('标准交付')
    const original = space.workflows.get
    space.workflows.list = async () => [{ id: 'risk-alert', title: '告警', file: 'alert.workflow.ts', rev: 'rev', editable: true, updatedAt: now, nodes: 1, runs: 0 }]
    space.workflows.get = async () => ({ ...await original('delivery'), id: 'risk-alert' })
    expect((await findEntities(f.deps, { q: 'risk-alert', types: ['workflow'] }, prefs)).items[0]).toMatchObject({ ref: { id: 'risk-alert' }, match: 'id' })
    for (const q of ['delivery-guide', '交付指南']) expect((await findEntities(f.deps, { q, types: ['knowledge'] }, prefs)).items[0]?.snapshot).toMatchObject({ title: '交付指南', status: '已就绪' })
  })
  it('同分按真实最近动静排，非法参数拒绝，上限 20', async () => {
    const f = await fixture()
    for (let i = 1; i <= 22; i++) await f.add('shop', `REQ-${String(i).padStart(3, '0')}`, '同名需求', undefined, `2026-11-09T${String(i).padStart(2, '0')}:00:00.000Z`)
    const result = await findEntities(f.deps, { q: '同名', limit: 99 }, prefs)
    expect(result.items).toHaveLength(20); expect(result.items[0]?.ref.id).toBe('REQ-022')
    for (const input of [{ q: '' }, { q: ' ' }, { q: '导出', limit: -1 }, { q: '导出', limit: 1.5 }, { q: '导出', types: ['file'] }]) await expect(findEntities(f.deps, input as never, prefs)).rejects.toMatchObject({ status: 400 })
  })
})

describe('Solo 推荐', () => {
  it('等你、失败、高风险、刚变化、在跑排序，每空间不超过半额', async () => {
    const f = await fixture(['a', 'b', 'c'])
    const old = '2026-11-07T12:00:00.000Z'
    const waiting = await f.add('a', 'REQ-001', '等人', 'waiting_human', old, 'run-wait')
    await waiting.space.stores.attention.create({ requestId: 'wait', requirementId: waiting.ref.id, runId: 'run-wait', nodeId: 'judge', ask: '确认', form: 'approve' })
    await f.add('a', 'REQ-002', '失败', 'failed', old, 'run-fail')
    await f.add('a', 'REQ-003', '不能刷屏', 'waiting_human', old, 'run-wait-2')
    await f.add('b', 'REQ-001', '高风险', undefined, old)
    await f.add('b', 'REQ-002', '刚变化', undefined, now)
    const running = await f.add('c', 'REQ-001', '在推进', undefined, old)
    const active = (await running.space.stores.workspaces.getRequirement('REQ-001'))!
    await writeFile(join(running.space.stores.workspaces.dir('REQ-001'), 'requirement.json'), JSON.stringify({ ...active, status: 'active' }))
    f.deps.extraRisks = async space => space.id === 'b' ? [{ key: 'test', kind: 'stalled', level: 'high', spaceId: 'b', requirementId: 'REQ-001', title: '高风险', detail: '', evidence: [], firstSeenAt: now, lastSeenAt: now, actions: [] }] : []
    const items = await stewardPicks(f.deps, prefs, 6)
    expect(items.map(item => item.reason)).toEqual(['waiting', 'waiting', 'failed', 'risk', 'changed', 'running'])
    expect(items.filter(item => item.ref.spaceId === 'a')).toHaveLength(3)
    expect((await stewardPicks(f.deps, prefs, 4)).filter(item => item.ref.spaceId === 'a')).toHaveLength(2)
    expect((await stewardPicks(f.deps, { ...prefs, mutedSpaces: ['a'] }, 6)).every(item => item.ref.spaceId !== 'a')).toBe(true)
  })
  it('排除旧交付与归档，保留一天内交付，空空间可返回空列表', async () => {
    const f = await fixture(['shop', 'empty'])
    await f.add('shop', 'REQ-001', '旧交付', 'succeeded', '2026-11-07T12:00:00.000Z', 'run-old')
    await f.add('shop', 'REQ-002', '刚交付', 'succeeded')
    const archived = await f.add('shop', 'REQ-003', '归档'); await archived.space.stores.workspaces.updateRequirement(archived.ref.id, { status: 'archived' })
    // 编辑旧交付不会改变其实际交付时间。
    await archived.space.stores.workspaces.updateRequirement('REQ-001', { updatedAt: now })
    expect((await stewardPicks(f.deps, prefs)).map(item => item.ref.id)).toEqual(['REQ-002'])
    f.visible.splice(0, 1)
    expect(await stewardPicks(f.deps, prefs)).toEqual([])
  })
})

describe('Solo 离线', () => {
  it.each([
    ['导出报表那个到哪了', 'card'], ['REQ-002 进度', 'card'], ['REQ-002 状态', 'card'], ['REQ-002 卡在哪', 'card'], ['REQ-003 到哪了', 'card'], ['REQ-002 阶段', 'stages'], ['REQ-002 的运行图', 'dag'], ['REQ-002 流程图', 'dag'], ['REQ-002 画布', 'dag'], ['REQ-002 DAG', 'dag'], ['REQ-002 节点图', 'dag'], ['run-0002 在跑什么', 'dag'], ['REQ-002 的失败判决节点', 'node'], ['REQ-002 judge 节点', 'node'], ['REQ-002 等我', 'attention'], ['REQ-002 待办', 'attention'], ['REQ-002 审批', 'attention'], ['REQ-002 要我决定', 'attention'],
  ])('%s → %s', async (text, view) => {
    const f = await fixture(); await f.add('shop', undefined, undefined, 'running')
    const message = await f.agent.ask({ text })
    expect(message.status).toBe('done'); expect(message.blocks).toHaveLength(1)
    expect(message.blocks![0]).toMatchObject({ type: 'entity', view, ref: { spaceId: 'shop', id: view === 'dag' ? 'run-0002' : view === 'node' ? 'judge' : 'REQ-002' } })
    expect(message.text.length).toBeLessThan(200)
  })
  it('同名出 pick；context 需求直接 show；节点、空间待办；无运行不猜', async () => {
    const f = await fixture(['shop', 'other']); await f.add('shop', undefined, undefined, 'running'); await f.add('other')
    const ambiguous = await f.agent.ask({ text: '导出报表那个到哪了' })
    expect(ambiguous.text).toBe('找到几个，你说的是哪一个？'); expect(ambiguous.blocks![0]).toMatchObject({ type: 'pick', items: expect.any(Array) })
    const selected = await f.agent.ask({ text: '看进度', context: [{ type: 'requirement', spaceId: 'shop', id: 'REQ-002' }] }, ambiguous.threadId)
    expect(selected.tools?.map(tool => tool.tool)).not.toContain('find'); expect(selected.blocks![0]).toMatchObject({ type: 'entity', view: 'card', ref: { spaceId: 'shop' } })
    const followup = await f.agent.ask({ text: '导出报表到哪了' }, ambiguous.threadId)
    const remembered = followup.tools?.find(tool => tool.tool === 'find')?.output as { items: Array<{ ref: StewardContextRef }> }
    expect(remembered.items[0]?.ref.spaceId).toBe('shop')
    const node = await f.agent.ask({ text: '在跑什么', context: [{ type: 'node', spaceId: 'shop', parent: 'run-0002', id: 'judge' }] })
    expect(node.blocks![0]).toMatchObject({ type: 'entity', view: 'node' })
    const namedNode = await f.agent.ask({ text: '失败判决节点在跑什么', context: [{ type: 'requirement', spaceId: 'shop', id: 'REQ-002' }] })
    expect(namedNode.blocks![0]).toMatchObject({ type: 'entity', view: 'node', ref: { parent: 'run-0002', id: 'judge' } })
    const scoped = await f.agent.ask({ text: '导出报表到哪了', context: [{ type: 'space', id: 'other' }] })
    expect(scoped.blocks![0]).toMatchObject({ type: 'entity', view: 'card', ref: { spaceId: 'other' } })
    const attention = await f.agent.ask({ text: '等我决定的', context: [{ type: 'space', id: 'shop' }] })
    expect(attention.blocks![0]).toMatchObject({ type: 'entity', view: 'attention' })
    const noRun = await f.agent.ask({ text: '运行图', context: [{ type: 'requirement', spaceId: 'other', id: 'REQ-002' }] })
    expect(noRun.text).toContain('还没开始运行'); expect(noRun.blocks ?? []).toEqual([])
  })
  it('未识别对象保持总览预设，不伪造实体', async () => {
    const f = await fixture()
    const message = await f.agent.ask({ text: '空间进度', context: [{ type: 'space', id: 'shop' }] })
    expect(message.blocks?.some(block => block.type === 'lanes')).toBe(true)
    expect(message.blocks?.some(block => block.type === 'entity')).toBe(false)
  })
})
