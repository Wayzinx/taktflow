import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import { createCommandRegistry } from '../commands/index.js'
import { bindCrudServices } from '../commands/crud-commands.js'
import type { CommandAudit, CommandSpec } from '../commands/contracts.js'
import type { RoomMessage, ChatResponse, RunState } from '../types.js'
import type { ProposalStep, WorkflowDocument, StewardBlock, StewardDelegation } from '../api.js'
import { StewardAgent, normalizeCitations } from './agent.js'
import { StewardStore } from './store.js'
import { proposalHash } from './proposals.js'
import { stewardId, type StewardDeps, type StewardSpace } from './contracts.js'
import { refreshRisks, setRiskState } from './risks.js'
import { buildDigest, startDigestScheduler } from './digest.js'
import { productMetrics, recordProductEvent, citationCoverage } from './metrics.js'
import { readStewardFile, redactSecrets } from './files.js'
import { sha256 } from '../util/hash.js'
import { stewardUndoCommands } from './undo-commands.js'
import type { KnowledgeBase } from '../types.js'
import type { KnowledgeStore } from '../interfaces.js'
import { stewardSuggestions } from './suggestions.js'
import { offlineAnswer } from './offline.js'
import { normalizeBlocks } from './blocks.js'
import { StewardError } from './contracts.js'

const roots: string[] = [],
  agents: StewardAgent[] = []
it('W2：peek 汇报 ID 稳定且不写入已读、风险、指标', async () => {
  const f = await fixture()
  const before = await f.agent.store.text('seen.json')
  const first = await buildDigest(f.deps, f.agent.store, undefined, true, true)
  f.clock('2026-11-06T10:01:00Z')
  const second = await buildDigest(f.deps, f.agent.store, undefined, true, true)
  expect(second.id).toBe(first.id)
  expect(await f.agent.store.text('seen.json')).toBe(before)
  expect(await f.agent.store.text('risks.json')).toBe('')
  expect(await f.agent.store.lines('metrics.jsonl')).toEqual([])
  await buildDigest(f.deps, f.agent.store)
  expect(await f.agent.store.text('seen.json')).not.toBe(before)
})
it('W5/W6：中文设置建议，显式空间覆盖默认空间', async () => {
  const f = await fixture()
  expect(await stewardSuggestions(f.deps, 'settings-knowledge', 'shop')).toEqual([
    '检查知识库设置',
  ])
  expect(await stewardSuggestions(f.deps, 'settings-members', 'shop')).toEqual([
    '检查成员设置',
  ])
  const calls: string[] = []
  for (const name of ['shop', '商店'])
    await offlineAnswer(
      `${name} 进度怎么样`,
      [],
      { trust: 'confirm', digestTimes: [], defaultSpace: 'other' },
      async (tool, input) => {
        if (tool === 'list_spaces')
          return { data: [{ id: 'shop', name: '商店' }], citations: [], summary: '' }
        expect(tool).toBe('show')
        calls.push(String((input.preset as Array<{ spaceId: string }>)[0]!.spaceId))
        return { data: { shown: 1, issues: [] }, citations: [], summary: '' }
      },
    )
  expect(calls).toEqual(['shop', 'shop'])
})
afterEach(async () => {
  vi.useRealTimers()
  agents.splice(0).forEach((agent) => agent.close())
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
describe('可视化块', () => {
  it('normalizeBlocks 截断上限、归一状态、隐藏 ref、丢弃未知命令且不抛', async () => {
    const raw = [
      {
        type: 'lanes',
        title: 'x'.repeat(80),
        rows: [{ title: '需求', ref: { type: 'requirement', spaceId: 'shop', id: 'hidden' }, stages: [{ label: '阶段', status: 'ok' }] }],
      },
      { type: 'actions', items: [{ kind: 'command', label: '删', commandId: 'missing' }, { kind: 'ask', label: '问', text: '继续？' }] },
      { type: 'stats', items: Array.from({ length: 8 }, (_, i) => ({ label: `L${i}`, value: i, tone: i ? 'bad' : 'success' })) },
      null,
      'bad',
      { type: 'unknown' },
      { type: 'callout', tone: 'success', title: '第七块' },
    ]
    const result = await normalizeBlocks(raw, { refVisible: async () => false, commandExists: async () => false })
    expect(result.blocks).toHaveLength(3)
    expect(result.blocks[0]).toMatchObject({ type: 'lanes', title: 'x'.repeat(60), rows: [{ stages: [{ status: 'todo' }] }] })
    expect((result.blocks[0] as Extract<StewardBlock, { type: 'lanes' }>).rows[0]!.ref).toBeUndefined()
    expect((result.blocks[1] as Extract<StewardBlock, { type: 'actions' }>).items).toHaveLength(1)
    expect((result.blocks[2] as Extract<StewardBlock, { type: 'stats' }>).items).toHaveLength(6)
    expect(result.issues.join('\n')).toContain('blocks[0].rows[0].stages[0].status')
    await expect(normalizeBlocks('garbage')).resolves.toMatchObject({ blocks: [] })
  })

  it('show preset 追加块、限制 6 块并发出 blocks 流事件', async () => {
    const f = await fixture()
    const first = await f.stores.workspaces.createRequirement({ title: '问候语支持空名字' })
    const second = await f.stores.workspaces.createRequirement({ title: '导出支持月份' })
    for (const [index, req] of [first, second].entries()) {
      const run: RunState = {
        runId: `run-${index + 1}`,
        requirementId: req.id,
        workflowId: 'flow',
        workflowVersion: '1',
        status: index === 0 ? 'running' : 'waiting_human',
        startedAt: `2026-11-06T10:0${index}:00.000Z`,
        args: {},
        expansions: [],
        nodes: { review: { id: 'review', status: index === 0 ? 'running' : 'waiting_human', attempts: 1, outputs: [] } },
      }
      await f.stores.runs.create(run, { id: 'flow', title: '交付流程', version: '1', stages: [{ id: 'review', title: '评审' }], nodes: [{ id: 'review', kind: 'review', title: '评审', stage: 'review', needs: [] }] })
    }
    const message = { id: 'm-blocks', threadId: f.thread.id, role: 'steward' as const, at: '2026-11-06T10:00:00.000Z', text: '', blocks: Array.from({ length: 4 }, (_, i) => ({ type: 'callout' as const, tone: 'neutral' as const, title: `旧${i}` })) }
    await f.agent.store.saveMessage(message)
    const events: Array<{ type: string; blocks?: StewardBlock[] }> = []
    f.agent.store.onThread(f.thread.id, (event) => events.push(event as { type: string; blocks?: StewardBlock[] }))
    const result = await f.agent.tools.call('show', { preset: [{ preset: 'space_progress', spaceId: 'shop' }] }, { threadId: f.thread.id, messageId: message.id, proposals: [], delegations: [], onBlocks: async (blocks) => { message.blocks = blocks; await f.agent.store.saveMessage(message); f.agent.store.emit(f.thread.id, { type: 'blocks', messageId: message.id, blocks }) } })
    expect(result.data).toMatchObject({ shown: 6 })
    // 回给模型的是本次新增块的文字摘要，结论据此写
    expect((result.data as { content: string[] }).content.join('\n')).toContain('问候语支持空名字')
    const saved = (await f.agent.store.messages(f.thread.id)).find((item) => item.id === message.id)!
    expect(saved.blocks).toHaveLength(6)
    const lanes = saved.blocks!.find((block): block is Extract<StewardBlock, { type: 'lanes' }> => block.type === 'lanes')
    expect(lanes?.rows).toHaveLength(2)
    expect(lanes?.rows[0]?.ref).toMatchObject({ type: 'requirement', spaceId: 'shop', id: first.id })
    expect(events.some((event) => event.type === 'blocks' && event.blocks?.length === 6)).toBe(true)
  })

  it('进度预设与总览同口径：阻塞按需求推导，时间线只留关键事件并用节点标题', async () => {
    const f = await fixture()
    const req = await f.stores.workspaces.createRequirement({ title: '导出支持月份' })
    const run: RunState = { runId: 'run-x', requirementId: req.id, workflowId: 'flow', workflowVersion: '1', status: 'failed', startedAt: '2026-11-06T10:00:00.000Z', args: {}, expansions: [], nodes: { review: { id: 'review', status: 'failed', attempts: 1, outputs: [] } } }
    await f.stores.runs.create(run, { id: 'flow', title: '交付流程', version: '1', stages: [{ id: 'review', title: '评审' }], nodes: [{ id: 'review', kind: 'review', title: '代码评审', stage: 'review', needs: [] }] })
    const actor = { type: 'system' as const, id: 'engine' }
    await f.stores.events.append('run-x', { type: 'harness.message', actor, nodeId: 'review', data: { role: 'assistant', text: '噪音' } })
    await f.stores.events.append('run-x', { type: 'node.failed', actor, nodeId: 'review', data: { error: 'boom', attempt: 1 } })
    const call = async (preset: Record<string, string>) => {
      const blocks: StewardBlock[][] = []
      await f.agent.tools.call('show', { preset: [preset] }, { threadId: f.thread.id, messageId: `m-${preset.preset}`, proposals: [], delegations: [], onBlocks: async (b) => void blocks.push(b) })
      return blocks.at(-1) ?? []
    }
    const space = await call({ preset: 'space_progress', spaceId: 'shop' })
    const stats = space.find((b): b is Extract<StewardBlock, { type: 'stats' }> => b.type === 'stats')!
    expect(stats.items.find((i) => i.label === '阻塞')?.value).toBe(1)
    expect(stats.items.map((i) => i.label)).toContain('累计 Token')
    const detail = await call({ preset: 'requirement_progress', spaceId: 'shop', requirementId: req.id })
    const timeline = detail.find((b): b is Extract<StewardBlock, { type: 'timeline' }> => b.type === 'timeline')!
    expect(timeline.items.map((i) => i.title)).toEqual(['代码评审 失败'])
  })

  it('离线进度和风险返回一句话并带 preset 块', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
    const call = async (tool: string, input: Record<string, unknown>) => {
      calls.push({ tool, input })
      return tool === 'list_spaces'
        ? { data: [{ id: 'shop', name: '商店' }], citations: [], summary: '' }
        : { data: { shown: 1, issues: [] }, citations: [], summary: '' }
    }
    expect(await offlineAnswer('现在进度怎么样', [{ type: 'space', id: 'shop' }], { trust: 'confirm', digestTimes: [] }, call)).toContain('阶段视图')
    expect(calls.at(-1)).toMatchObject({ tool: 'show', input: { preset: [{ preset: 'space_progress', spaceId: 'shop' }] } })
    expect(await offlineAnswer('有什么风险', [{ type: 'space', id: 'shop' }], { trust: 'confirm', digestTimes: [] }, call)).toContain('风险')
    expect(calls.at(-1)).toMatchObject({ tool: 'show', input: { preset: [{ preset: 'risks', spaceId: 'shop' }] } })
  })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-steward-'))
  roots.push(root)
  const stores = await initProject(join(root, 'shop'), { name: '商店' })
  let now = new Date('2026-11-06T10:00:00Z'),
    rev = 'r1'
  const audit: CommandAudit[] = [],
    listeners = new Set<(message: RoomMessage) => void>()
  bindCrudServices(stores, {
    workflowEdit: async () => {
      rev = 'r2'
      return { rev }
    },
    workflowConvert: async () => ({}),
    configPatch: async (patch) => {
      Object.assign(stores.config, patch)
      return stores.config
    },
  })
  const failure: CommandSpec = {
    id: 'test.fail',
    title: '失败',
    risk: 'write',
    kind: 'command',
    input: { type: 'object' },
    handler: async () => {
      throw new Error('受控失败')
    },
  }
  const commands = createCommandRegistry({
    stores,
    audit: async (entry) => {
      audit.push(entry)
    },
    extensions: [failure],
  })
  const document = (): WorkflowDocument => ({
    id: 'flow',
    file: 'workflows/flow.workflow.ts',
    source: `revision ${rev}`,
    rev,
    diagnostics: [],
    layout: { nodes: {} },
      model: {
        editable: true,
        meta: {
        id: 'flow',
        title: { kind: 'literal', value: '交付流程' },
          version: { kind: 'literal', value: '1' },
        },
        nodes: [
          {
            id: 'review-code',
            kind: 'review',
            props: {
              id: { kind: 'literal', value: 'review-code' },
              title: { kind: 'literal', value: '代码评审' },
              stage: { kind: 'literal', value: 'review' },
            },
          },
          {
            id: 'acceptance',
            kind: 'human',
            props: {
              id: { kind: 'literal', value: 'acceptance' },
              title: { kind: 'literal', value: '验收' },
              stage: { kind: 'literal', value: 'acceptance' },
              needs: { kind: 'literal', value: ['review-code'] },
            },
          },
        ],
        stages: { kind: 'literal', value: [{ id: 'review', title: '评审' }, { id: 'acceptance', title: '验收' }] },
      },
  })
  const space: StewardSpace = {
    id: 'shop',
    name: '商店',
    dir: stores.projectDir,
    stores,
    commands,
    workflows: {
      get: async () => document(),
      rollback: async (_, value) => {
        rev = value
        return document()
      },
    },
    postToLead: async () => 'sent-1',
    onChat: (_, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const serverSpaces: Array<{ id: string; name: string; requirements: number; active: number }> = []
  const deps: StewardDeps = {
    dataDir: (user) => join(root, '.steward', stewardId(user)),
    spaces: async () => [{ id: 'shop', name: '商店', requirements: 0, active: 0 }, ...serverSpaces],
    open: async (id) => {
      if (id !== 'shop') throw new StewardError(404, '空间不存在，请刷新空间列表')
      return space
    },
    now: () => now,
    leadTimeoutMs: 5,
    applyWorkflowEdits: (source) => ({ source: `${source}\nchanged` }),
    serverCommands: {
      list: () => [
        {
          id: 'space.create',
          title: '创建空间',
          risk: 'write',
          kind: 'command',
          input: { type: 'object', required: ['id', 'name', 'template'] },
        },
        {
          id: 'space.archive',
          title: '归档空间',
          risk: 'write',
          kind: 'command',
          input: { type: 'object' },
        },
      ],
      run: async (id, input) => {
        if (id === 'space.create')
          serverSpaces.push({
            id: String(input.id),
            name: String(input.name),
            requirements: 0,
            active: 0,
          })
        else
          serverSpaces.splice(
            serverSpaces.findIndex((s) => s.id === input.id),
            1,
          )
        return { ok: true, message: '完成', result: input }
      },
    },
  }
  const agent = new StewardAgent(deps, 'alice')
  agents.push(agent)
  const thread = await agent.store.createThread('测试', now.toISOString())
  const create: ProposalStep = {
    kind: 'command',
    spaceId: 'shop',
    commandId: 'requirement.create',
    input: { title: '草稿', start: false },
  }
  return {
    root,
    stores,
    deps,
    space,
    agent,
    thread,
    create,
    audit,
    listeners,
    clock: (date: string) => {
      now = new Date(date)
    },
    revision: (value: string) => {
      rev = value
    },
  }
}
describe('提案生命周期', () => {
  it('list_commands 对已归档（打不开）的空间退回服务级命令，其它工具照常报 404', async () => {
    const f = await fixture(),
      ctx = { threadId: f.thread.id, messageId: 'm-cmd', proposals: [], delegations: [] }
    const result = await f.agent.tools.call('list_commands', { spaceId: 'shop@20261107-195504' }, ctx)
    expect((result.data as Array<{ id: string }>).map((c) => c.id)).toContain('space.archive')
    await expect(f.agent.tools.call('space_overview', { spaceId: 'shop@20261107-195504' }, ctx)).rejects.toMatchObject({ status: 404 })
  })
  it('list_commands 给了空间也列出 scope=server 的空间管理命令（归档 / 删除空间）', async () => {
    const f = await fixture(),
      ctx = { threadId: f.thread.id, messageId: 'm-cmd', proposals: [], delegations: [] }
    const rows = (await f.agent.tools.call('list_commands', { spaceId: 'shop' }, ctx)).data as Array<{ id: string; scope: string }>
    expect(rows.find((c) => c.id === 'space.archive')).toMatchObject({ scope: 'server' })
    expect(rows.find((c) => c.id === 'requirement.create')).toMatchObject({ scope: 'space' })
    expect((await f.agent.tools.specs()).find((t) => t.name === 'get_config')?.description).toContain('成员')
  })
  it('引用定位到具体页面：需求列表指向需求页，运行失败的节点带 ?node=', async () => {
    const f = await fixture(),
      ctx = { threadId: f.thread.id, messageId: 'm-cite', proposals: [], delegations: [] }
    const req = await f.stores.workspaces.createRequirement({ title: '问候语' })
    expect((await f.agent.tools.call('list_requirements', { spaceId: 'shop' }, ctx)).citations[0]).toMatchObject({ href: '/s/shop/requirements' })
    const run: RunState = { runId: 'run-20261109-180307-4aa0', requirementId: req.id, workflowId: 'flow', workflowVersion: '1', status: 'failed', startedAt: '2026-11-06T09:00:00.000Z', args: {}, expansions: [],
      nodes: { clarify: { id: 'clarify', status: 'failed', attempts: 1, outputs: [], error: 'ACP 协议错误' }, build: { id: 'build', status: 'pending', attempts: 0, outputs: [] } } }
    await f.stores.runs.create(run, { id: 'flow', title: '交付流程', version: '1', stages: [], nodes: [{ id: 'clarify', kind: 'agent', title: '需求澄清', needs: [] }, { id: 'build', kind: 'agent', title: '开发', needs: ['clarify'] }] })
    const cites = (await f.agent.tools.call('run_status', { spaceId: 'shop', runId: run.runId }, ctx)).citations
    expect(cites).toContainEqual({ label: `需求澄清（${run.runId}）`, href: `/s/shop/run/${run.runId}?node=clarify`, kind: 'node' })
    expect(cites.some((c) => c.href.includes('node=build'))).toBe(false)
  })
  it('空间管理命令忽略 spaceId：归档空间不在活跃列表里也能出提案并执行', async () => {
    const f = await fixture(),
      step: ProposalStep = { kind: 'command', spaceId: 'shop@20261107-195504', commandId: 'space.archive', input: { id: 'shop@20261107-195504' } }
    const p = await f.agent.proposals.create(f.thread.id, '归档', '用户要求', [step])
    expect(p.status).toBe('pending')
    expect((await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' })).status).toBe('applied')
  })
  it('hash 绑定、批准执行、跨实例撤销与审计身份', async () => {
    const f = await fixture(),
      p = await f.agent.proposals.create(f.thread.id, '建需求', '用户要求', [f.create])
    await expect(
      f.agent.proposals.approve(p.id, { hash: 'wrong' }, { type: 'human', id: 'alice' }),
    ).rejects.toMatchObject({ status: 409 })
    expect(await f.stores.workspaces.listRequirements()).toHaveLength(0)
    const applied = await f.agent.proposals.approve(
      p.id,
      { hash: p.hash },
      { type: 'human', id: 'alice' },
    )
    expect(applied.status).toBe('applied')
    expect(applied.undoUntil).toBe('2026-11-07T10:00:00.000Z')
    const second = new StewardAgent(f.deps, 'alice')
    agents.push(second)
    expect((await second.proposals.undo(p.id, { type: 'human', id: 'alice' })).status).toBe(
      'reverted',
    )
    expect((await f.stores.workspaces.listRequirements())[0]?.status).toBe('archived')
    expect(f.audit[0]).toMatchObject({
      actor: { type: 'human', id: 'alice' },
      reason: expect.stringContaining(`管家提案 ${p.id}`),
      onBehalfOf: 'steward',
    })
  })
  it('规范化 hash 与编辑后批准', async () => {
    const f = await fixture(),
      p = await f.agent.proposals.create(f.thread.id, '草稿', '用户要求', [f.create])
    expect(proposalHash([{ kind: 'command', commandId: 'x', input: { b: 1, a: 2 } }])).toBe(
      proposalHash([{ input: { a: 2, b: 1 }, commandId: 'x', kind: 'command' }]),
    )
    const applied = await f.agent.proposals.approve(
      p.id,
      {
        hash: p.hash,
        steps: [{ ...f.create, input: { title: '修改标题', start: false } } as ProposalStep],
      },
      { type: 'human', id: 'alice' },
    )
    expect(applied).toMatchObject({ status: 'applied', edited: true })
    expect(applied.hash).not.toBe(p.hash)
    expect((await f.stores.workspaces.listRequirements())[0]?.title).toBe('修改标题')
  })
  it('workflow 基线变化后 stale，未变化可执行和回滚', async () => {
    const f = await fixture(),
      step: ProposalStep = {
        kind: 'workflow',
        spaceId: 'shop',
        workflowId: 'flow',
        baseRev: 'r1',
        edits: [{ op: 'setMeta', key: 'title', value: '新标题' }],
      }
    const p = await f.agent.proposals.create(f.thread.id, '改流程', '用户要求', [step])
    expect(p.previews?.[0]?.body).toContain('+++ b/workflows/')
    f.revision('external')
    await expect(
      f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' }),
    ).rejects.toMatchObject({ status: 409 })
    expect((await f.agent.store.proposal(p.id)).status).toBe('stale')
    f.revision('r1')
    const next = await f.agent.proposals.create(f.thread.id, '改流程', '用户要求', [step])
    expect(
      (
        await f.agent.proposals.approve(
          next.id,
          { hash: next.hash },
          { type: 'human', id: 'alice' },
        )
      ).status,
    ).toBe('applied')
    expect((await f.space.workflows.get('flow')).rev).toBe('r2')
    expect((await f.agent.proposals.undo(next.id, { type: 'human', id: 'alice' })).status).toBe(
      'reverted',
    )
    expect((await f.space.workflows.get('flow')).rev).toBe('r1')
  })
  it('中途失败倒序回滚已经创建的需求', async () => {
    const f = await fixture(),
      p = await f.agent.proposals.create(f.thread.id, '多步', '用户要求', [
        f.create,
        { kind: 'command', spaceId: 'shop', commandId: 'test.fail', input: {} },
      ])
    const result = await f.agent.proposals.approve(
      p.id,
      { hash: p.hash },
      { type: 'human', id: 'alice' },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('受控失败')
    expect((await f.stores.workspaces.listRequirements())[0]?.status).toBe('archived')
  })
  it('auto-low 只自动执行可撤销的 low 提案', async () => {
    const f = await fixture()
    await f.agent.store.write('prefs.json', { trust: 'auto-low', digestTimes: [] })
    expect(
      await f.agent.proposals.create(f.thread.id, '草稿', '用户要求', [f.create]),
    ).toMatchObject({ status: 'applied', auto: true })
    expect(
      await f.agent.proposals.create(f.thread.id, '空间', '用户要求', [
        {
          kind: 'command',
          commandId: 'space.create',
          input: { id: 'other', name: '其他', template: 'standard' },
        },
      ]),
    ).toMatchObject({ status: 'pending', risk: 'medium' })
  })
  it('修改后的目标和超过 24 小时的提案不能撤销', async () => {
    const f = await fixture(),
      p = await f.agent.proposals.create(f.thread.id, '草稿', '用户要求', [f.create])
    await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' })
    const req = (await f.stores.workspaces.listRequirements())[0]!
    await f.stores.workspaces.updateRequirement(req.id, { title: '他人修改' })
    await expect(
      f.agent.proposals.undo(p.id, { type: 'human', id: 'alice' }),
    ).rejects.toMatchObject({ status: 409 })
    f.clock('2026-11-08T10:00:00Z')
    await expect(f.agent.proposals.undo(p.id, { type: 'human', id: 'alice' })).rejects.toThrow(
      '24 小时',
    )
  })
  it('并发批准最多执行一次，拒绝后不能批准', async () => {
    const f = await fixture(),
      p = await f.agent.proposals.create(f.thread.id, '草稿', '用户要求', [f.create])
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await f.stores.workspaces.listRequirements()).toHaveLength(1)
    const rejected = await f.agent.proposals.create(f.thread.id, '拒绝', '用户要求', [f.create])
    await f.agent.proposals.reject(rejected.id, { type: 'human', id: 'alice' }, '不需要')
    await expect(
      f.agent.proposals.approve(
        rejected.id,
        { hash: rejected.hash },
        { type: 'human', id: 'alice' },
      ),
    ).rejects.toMatchObject({ status: 409 })
  })
  it('文件预览、基线保护、执行和撤销', async () => {
    const f = await fixture()
    await writeFile(join(f.stores.projectDir, 'agents/steward.md'), 'original')
    const step: ProposalStep = {
      kind: 'file',
      spaceId: 'shop',
      path: 'agents/steward.md',
      baseHash: sha256('original'),
      content: 'changed',
    }
    const p = await f.agent.proposals.create(f.thread.id, '改角色', '用户要求', [step])
    await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' })
    expect(await readFile(join(f.stores.projectDir, step.path), 'utf8')).toBe('changed')
    await f.agent.proposals.undo(p.id, { type: 'human', id: 'alice' })
    expect(await readFile(join(f.stores.projectDir, step.path), 'utf8')).toBe('original')
    const stale = await f.agent.proposals.create(f.thread.id, '改角色', '用户要求', [step])
    await writeFile(join(f.stores.projectDir, step.path), 'other')
    await expect(
      f.agent.proposals.approve(stale.id, { hash: stale.hash }, { type: 'human', id: 'alice' }),
    ).rejects.toMatchObject({ status: 409 })
  })
  it('提案步骤畸形输入只返回可操作 400，不崩溃', async () => {
    const f = await fixture()
    await expect(
      f.agent.proposals.create(f.thread.id, '坏提案', '用户要求', [
        { type: 'command', commandId: 'requirement.create', input: { title: '错形状' } },
      ] as unknown as ProposalStep[]),
    ).rejects.toThrow('字段名必须是 kind')
    await expect(
      f.agent.proposals.create(f.thread.id, '坏命令', '用户要求', [
        { kind: 'command', spaceId: 'shop', input: { title: '缺 commandId' } } as unknown as ProposalStep,
      ]),
    ).rejects.toThrow('steps[0].commandId')
    await expect(
      f.agent.proposals.create(f.thread.id, '近似命令', '用户要求', [
        { kind: 'command', spaceId: 'shop', commandId: 'requirement.creat', input: { title: '近似' } },
      ]),
    ).rejects.toThrow('requirement.create')
  })
  it('workflow edit 校验列出节点 id，并接受按提示改正后的 workflow 步骤', async () => {
    const f = await fixture()
    await expect(
      f.agent.proposals.create(f.thread.id, '坏 workflow', '用户要求', [
        {
          kind: 'workflow',
          spaceId: 'shop',
          workflowId: 'flow',
          baseRev: 'r1',
          edits: [{ op: 'setNeeds', id: 'acceptance', needs: ['missing-node'] }],
        },
      ]),
    ).rejects.toThrow('review-code')
    const p = await f.agent.proposals.create(f.thread.id, '加人工确认', '用户要求', [
      {
        kind: 'workflow',
        spaceId: 'shop',
        workflowId: 'flow',
        baseRev: 'r1',
        edits: [
          {
            op: 'addNode',
            kind: 'human',
            after: 'review-code',
            props: {
              id: { kind: 'literal', value: 'prelaunch-confirm' },
              title: { kind: 'literal', value: '上线前人工确认' },
              stage: { kind: 'literal', value: 'acceptance' },
              needs: { kind: 'literal', value: ['review-code'] },
            },
          },
          { op: 'setNeeds', id: 'acceptance', needs: ['prelaunch-confirm'] },
        ],
      },
    ])
    expect(p.steps[0]).toMatchObject({ kind: 'workflow' })
    expect(p.previews?.[0]?.body).toContain('changed')
  })
  it('profile 提案可自动执行并保留审计', async () => {
    const f = await fixture()
    await f.agent.store.write('prefs.json', { trust: 'auto-low', digestTimes: [] })
    const p = await f.agent.proposals.create(f.thread.id, '记住偏好', '用户要求', [
      { kind: 'file', path: 'profile.md', content: '关注 shop' },
    ])
    expect(p).toMatchObject({ auto: true, status: 'applied' })
    expect(await f.agent.store.text('profile.md')).toBe('关注 shop')
    await f.agent.proposals.undo(p.id, { type: 'human', id: 'alice' })
    expect(await f.agent.store.text('profile.md')).toBe('')
    expect(await f.agent.store.lines('audit.jsonl')).toHaveLength(2)
  })
})
describe('问答与工具', () => {
  it('脚本化 chat 查询进度，编号只保留实际引用，附件不持久化', async () => {
    const f = await fixture()
    await f.stores.workspaces.createRequirement({ title: '交付查询' })
    const replies: ChatResponse[] = [
      {
        stopReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call1', name: 'space_overview', arguments: '{"spaceId":"shop"}' }],
        },
      },
      {
        stopReason: 'end',
        message: { role: 'assistant', content: '有 1 条需求[1]，无效引用[99]。' },
      },
    ]
    f.deps.chat = vi.fn(async () => replies.shift()!)
    const agent = new StewardAgent(f.deps, 'alice')
    agents.push(agent)
    const events: unknown[] = []
    agent.store.onThread(f.thread.id, (e) => events.push(e))
    const message = await agent.ask(
      {
        text: '现在进度怎么样',
        context: [{ type: 'space', id: 'shop', spaceId: 'shop' }],
        attachments: [{ name: 'note', content: 'ephemeral-attachment' }],
      },
      f.thread.id,
    )
    expect(message.status).toBe('done')
    expect(message.text).toBe('有 1 条需求[1]，无效引用。')
    expect(message.citations).toEqual([{ label: '商店', href: '/s/shop', kind: 'space' }])
    expect(message.tools?.[0]?.ok).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'delta' }))
    expect(await agent.store.text(`threads/${f.thread.id}.jsonl`)).not.toContain(
      'ephemeral-attachment',
    )
    expect(
      normalizeCitations('引用[3][1][9]', [
        { label: 'a', href: '/a' },
        { label: 'b', href: '/b' },
        { label: 'c', href: '/c' },
      ]),
    ).toEqual({
      text: '引用[1][2]',
      citations: [
        { label: 'c', href: '/c' },
        { label: 'a', href: '/a' },
      ],
    })
  })
  it('工具 schema 暴露 propose anyOf，workflow_get 返回可编辑视图且空间解析不代答', async () => {
    const f = await fixture()
    await f.stores.workspaces.createRequirement({ id: 'REQ-001', title: '问候语支持空名字' })
    const propose = (await f.agent.tools.specs()).find((tool) => tool.name === 'propose')!
    expect(JSON.stringify(propose.parameters)).toContain('anyOf')
    expect(JSON.stringify(propose.parameters)).toContain('addNode')
    const context = { threadId: f.thread.id, messageId: 'm', proposals: [], delegations: [] }
    const view = await f.agent.tools.call(
      'workflow_get',
      { spaceId: 'shop', workflowId: 'flow' },
      context,
    )
    expect(view.data).toMatchObject({ rev: 'r1', source: undefined })
    expect(JSON.stringify(view.data)).toContain('review-code')
    const withSource = await f.agent.tools.call(
      'workflow_get',
      { spaceId: 'shop', workflowId: 'flow', includeSource: true },
      context,
    )
    expect(JSON.stringify(withSource.data)).toContain('revision r1')
    const resolved = await f.agent.tools.call('resolve_space', { name: '作者版标准交付示例' }, context)
    expect(resolved.data).toMatchObject({ exact: false })
    expect(JSON.stringify(resolved.data)).toContain('不要用其他空间代答')
    const requirement = await f.agent.tools.call(
      'resolve_requirement',
      { spaceId: 'shop', name: '不存在需求' },
      context,
    )
    expect(requirement.data).toMatchObject({ exact: false })
    expect(JSON.stringify(requirement.data)).toContain('不要用其他需求代答')
    const matched = await f.agent.tools.call(
      'list_requirements',
      { spaceId: 'shop', query: '问候语' },
      context,
    )
    expect(JSON.stringify(matched.data)).toContain('REQ-001')
  })
  it('脚本化模型先给错形状，读取错误后第二次生成正确 workflow 提案', async () => {
    const f = await fixture()
    const bad = JSON.stringify({
      title: '加确认',
      summary: '用户要求',
      steps: [{ type: 'workflow', spaceId: 'shop', workflowId: 'flow', baseRev: 'r1', edits: [] }],
    })
    const good = JSON.stringify({
      title: '加确认',
      summary: '用户要求',
      steps: [
        {
          kind: 'workflow',
          spaceId: 'shop',
          workflowId: 'flow',
          baseRev: 'r1',
          edits: [
            {
              op: 'addNode',
              kind: 'human',
              after: 'review-code',
              props: {
                id: { kind: 'literal', value: 'prelaunch-confirm' },
                title: { kind: 'literal', value: '上线前人工确认' },
                stage: { kind: 'literal', value: 'acceptance' },
                needs: { kind: 'literal', value: ['review-code'] },
              },
            },
            { op: 'setNeeds', id: 'acceptance', needs: ['prelaunch-confirm'] },
          ],
        },
      ],
    })
    const replies: ChatResponse[] = [
      { stopReason: 'tool_calls', message: { role: 'assistant', content: '', toolCalls: [{ id: 'bad', name: 'propose', arguments: bad }] } },
      { stopReason: 'tool_calls', message: { role: 'assistant', content: '', toolCalls: [{ id: 'good', name: 'propose', arguments: good }] } },
      { stopReason: 'end', message: { role: 'assistant', content: '已生成提案。' } },
    ]
    f.deps.chat = vi.fn(async () => replies.shift()!)
    const agent = new StewardAgent(f.deps, 'alice')
    agents.push(agent)
    const result = await agent.ask({ text: '改 workflow' }, f.thread.id)
    expect(result.status).toBe('done')
    expect(result.text).toBe('已生成提案。')
    expect(result.tools?.map((tool) => tool.ok)).toEqual([false, true])
    expect(result.tools?.[0]?.summary).toContain('缺少必填字段 kind')
    expect(result.proposalIds).toHaveLength(1)
  })
  it('离线进度、风险、待办、新建需求/空间和设置入口', async () => {
    const f = await fixture()
    const context = [{ type: 'space' as const, spaceId: 'shop', id: 'shop' }]
    for (const text of ['进度', '风险', '待办']) {
      const answer = await f.agent.ask({ text, context })
      expect(answer.status).toBe('done')
      expect(answer.offline).toBe(true)
      expect(answer.text).toContain('[1]')
    }
    for (const text of [
      '新建需求 月份筛选',
      'create requirement Export',
      '新建空间 我的项目',
      'create space My Project',
    ]) {
      const answer = await f.agent.ask({ text, context })
      expect(answer.status).toBe('done')
      expect(answer.proposalIds).toHaveLength(1)
      expect((await f.agent.store.proposal(answer.proposalIds![0]!)).status).toBe('pending')
    }
    // 建议里的说法没带名字：追问，不建提案
    for (const [text, ask] of [['新建一个需求', '新需求叫什么'], ['新建项目空间', '新空间叫什么']]) {
      const answer = await f.agent.ask({ text: text!, context })
      expect(answer.text).toContain(ask)
      expect(answer.proposalIds ?? []).toHaveLength(0)
    }
    expect((await f.agent.ask({ text: '帮我优化量子计算', context })).text).toContain(
      '需要先配置管家模型',
    )
  })
  it('同一工具同一错误连续两次即停止并总结', async () => {
    const f = await fixture()
    let rounds = 0
    f.deps.chat = async () => {
      rounds++
      return {
        stopReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: String(rounds), name: 'not_exists', arguments: '{}' }],
        },
      }
    }
    const agent = new StewardAgent(f.deps, 'alice')
    agents.push(agent)
    const result = await agent.ask({ text: '执行' })
    expect(rounds).toBe(2)
    expect(result.text).toContain('连续 2 次')
    expect(result.text).toContain('最后的错误')
    expect(result.tools).toHaveLength(2)
    expect(result.tools!.every((tool) => tool.ok === false)).toBe(true)
  })
  it('工具循环上限为 14 轮，并带进展与最后错误', async () => {
    const f = await fixture()
    let rounds = 0
    f.deps.chat = async () => {
      rounds++
      return {
        stopReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: String(rounds), name: `not_exists_${rounds}`, arguments: '{}' }],
        },
      }
    }
    const agent = new StewardAgent(f.deps, 'alice')
    agents.push(agent)
    const result = await agent.ask({ text: '执行' })
    expect(rounds).toBe(14)
    expect(result.text).toContain('14 轮工具调用上限')
    expect(result.text).toContain('最后的错误')
    expect(result.tools).toHaveLength(14)
  })
  it('Lead 超时返回已转达，后续只回填匹配的回复', async () => {
    const f = await fixture()
    await f.stores.workspaces.createRequirement({ id: 'REQ-001', title: '转达' })
    const updated: StewardDelegation[] = [],
      context = {
        threadId: f.thread.id,
        messageId: 'message',
        proposals: [],
        delegations: [],
        onDelegation: async (d: StewardDelegation) => {
          updated.push({ ...d })
        },
      }
    const result = await f.agent.tools.call(
      'ask_lead',
      { spaceId: 'shop', requirementId: 'REQ-001', message: '继续执行' },
      context,
    )
    expect(result.data).toMatchObject({ status: 'sent', messageId: 'sent-1' })
    const reply: RoomMessage = {
      id: 'reply',
      roomId: 'REQ-001',
      seq: 2,
      author: { type: 'agent', role: 'lead', harness: 'native' },
      at: '2026-11-06T10:01:00Z',
      kind: 'text',
      text: '已完成',
      replyTo: 'other',
    }
    for (const listener of f.listeners) listener(reply)
    expect(updated).toHaveLength(1)
    for (const listener of f.listeners) listener({ ...reply, replyTo: 'sent-1' })
    await vi.waitFor(() => expect(updated).toHaveLength(2))
    await vi.waitFor(async () => expect(await f.agent.store.lines('feed.jsonl')).toHaveLength(2))
    expect(updated[1]?.status).toBe('replied')
    await vi.waitFor(() => expect(f.listeners.size).toBe(0))
  })
  it('禁读内部/密钥/穿越/软链与大文件，脱敏配置', async () => {
    const f = await fixture()
    for (const path of ['../outside', '.takt/runs/a', 'agents/x.secret.md', '/etc/passwd'])
      await expect(readStewardFile(f.stores.projectDir, path)).rejects.toThrow()
    await symlink(f.root, join(f.stores.projectDir, 'agents/outside'))
    await expect(readStewardFile(f.stores.projectDir, 'agents/outside/file')).rejects.toThrow(
      '符号链接',
    )
    await writeFile(join(f.stores.projectDir, 'agents/big'), 'x'.repeat(65537))
    await expect(readStewardFile(f.stores.projectDir, 'agents/big')).rejects.toThrow('64KB')
    expect(
      redactSecrets({
        apiKey: 'value',
        nested: { password: 'hidden' },
        url: 'https://u:p@example.test',
      }),
    ).toEqual({ apiKey: '***', nested: { password: '***' }, url: '***' })
    expect(() => stewardId('../alice')).toThrow()
  })
  it('跨实例并发 JSONL 不丢数据，会话标题和搜索持久化', async () => {
    const f = await fixture(),
      other = new StewardStore(f.agent.store.dir)
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        (n % 2 ? other : f.agent.store).append('metrics.jsonl', { n }),
      ),
    )
    expect(await other.lines('metrics.jsonl')).toHaveLength(12)
    const thread = await other.createThread(
      '这是一个超过二十个字的中文标题需要截取并且搜索',
      '2026-11-06T10:00:00Z',
    )
    expect(thread.title).toBe('这是一个超过二十个字的中文标题需要截取并…')
    expect(await f.agent.store.threads('中文标题')).toHaveLength(1)
  })
})
describe('风险汇报与度量', () => {
  it('风险去重、升级、24 小时提醒、忽略、稍后恢复与解决', async () => {
    const f = await fixture()
    await f.stores.workspaces.createRequirement({ id: 'REQ-001', title: '风险' })
    let present = true,
      high = false
    f.deps.extraRisks = async () =>
      present
        ? [
            {
              key: 'knowledge:shop/REQ-001/kb',
              kind: 'knowledge',
              level: high ? 'high' : 'medium',
              spaceId: 'shop',
              title: '知识过期',
              detail: '测试',
              evidence: [],
              actions: [],
              firstSeenAt: '2026-11-06T10:00:00Z',
              lastSeenAt: '2026-11-06T10:00:00Z',
            },
          ]
        : []
    const first = (await refreshRisks(f.deps, f.agent.store))[0]!
    await refreshRisks(f.deps, f.agent.store)
    expect(await f.agent.store.lines('feed.jsonl')).toHaveLength(1)
    high = true
    await refreshRisks(f.deps, f.agent.store)
    expect(await f.agent.store.lines('feed.jsonl')).toHaveLength(2)
    f.clock('2026-11-07T11:00:00Z')
    await refreshRisks(f.deps, f.agent.store)
    expect(await f.agent.store.lines('feed.jsonl')).toHaveLength(3)
    await setRiskState(f.deps, f.agent.store, first.key, {
      state: 'snoozed',
      until: '2026-11-09T11:00:00Z',
    })
    f.clock('2026-11-08T12:00:00Z')
    expect((await refreshRisks(f.deps, f.agent.store))[0]?.state).toBe('snoozed')
    f.clock('2026-11-09T12:00:00Z')
    expect((await refreshRisks(f.deps, f.agent.store))[0]?.state).toBe('open')
    await setRiskState(f.deps, f.agent.store, first.key, { state: 'ignored' })
    present = false
    expect((await refreshRisks(f.deps, f.agent.store))[0]?.state).toBe('resolved')
  })
  it('汇报按 since 和静音过滤，读取更新 seen，调度同一分钟只发送一次', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
    const f = await fixture()
    await f.stores.workspaces.createRequirement({ title: '窗口内' })
    const now = new Date()
    f.clock(now.toISOString())
    const since = new Date(now.getTime() - 3600000).toISOString()
    expect(
      (await buildDigest(f.deps, f.agent.store, since)).progress.some((p) => p.kind === 'created'),
    ).toBe(true)
    expect(await f.agent.store.read('seen.json')).toEqual({ at: now.toISOString() })
    await f.agent.store.write('prefs.json', {
      trust: 'confirm',
      digestTimes: [],
      mutedSpaces: ['shop'],
    })
    expect((await buildDigest(f.deps, f.agent.store, since)).progress).toEqual([])
    const monday = new Date('2026-11-09T09:30:00')
    f.clock(monday.toISOString())
    await f.agent.store.write('prefs.json', { trust: 'confirm', digestTimes: ['09:30'] })
    const scheduler = startDigestScheduler(f.deps, () => [f.agent.store])
    try {
      await scheduler.tick()
      await scheduler.tick()
      expect(
        (await f.agent.store.lines<{ type: string }>('feed.jsonl')).filter(
          (i) => i.type === 'digest',
        ),
      ).toHaveLength(1)
    } finally {
      scheduler.close()
    }
  })
  it('产品指标 7 天趋势、反馈原因和页面事件', async () => {
    const f = await fixture()
    await recordProductEvent(f.deps, f.agent.store, {
      type: 'dialog.submit',
      feature: 'requirement.create',
      ms: 500,
      detail: { criteriaSuggested: true, criteriaAdopted: true },
    })
    await f.agent.store.append('metrics.jsonl', {
      at: '2026-11-06T10:00:00Z',
      feature: 'steward.answer',
      type: 'feedback',
      rating: 'down',
      reason: 'verbose',
    })
    const metrics = await productMetrics(f.deps, f.agent.store)
    expect(
      metrics.find((m) => m.feature === 'requirement.create' && m.metric === 'completion_ms'),
    ).toMatchObject({ value: 500, window: '7d', trend: expect.any(Array) })
    expect(metrics.find((m) => m.metric === 'down_verbose')?.value).toBe(1)
    expect(metrics.find((m) => m.feature === 'requirement.create' && m.metric === 'submit_rate')?.samples).toBe(0)
    expect(metrics.find((m) => m.metric === 'started_within_5m')?.samples).toBe(0)
    expect(metrics.find((m) => m.feature === 'requirement.create' && m.metric === 'submissions')?.value).toBe(0)
    expect(metrics.every((m) => m.trend?.length === 7 && m.hint)).toBe(true)
    expect(citationCoverage('有 2 个需求[1]。另有 3 个待办。')).toBe(0.5)
  })
})

it('同一文件连续修改后仍能按相反顺序完整撤销', async () => {
  const f = await fixture()
  await writeFile(join(f.stores.projectDir, 'agents/sequence.md'), 'zero')
  const p = await f.agent.proposals.create(f.thread.id, '连续修改', '测试', [
    { kind: 'file', spaceId: 'shop', path: 'agents/sequence.md', content: 'one' },
    { kind: 'file', spaceId: 'shop', path: 'agents/sequence.md', content: 'two' },
  ])
  expect(
    (await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' }))
      .status,
  ).toBe('applied')
  expect((await f.agent.proposals.undo(p.id, { type: 'human', id: 'alice' })).status).toBe(
    'reverted',
  )
  expect(await readFile(join(f.stores.projectDir, 'agents/sequence.md'), 'utf8')).toBe('zero')
})
it('重启后恢复未完成转达，从群聊读回匹配回复，不重复发送', async () => {
  const f = await fixture(),
    req = await f.stores.workspaces.createRequirement({ id: 'REQ-001', title: '转达恢复' })
  await f.agent.store.saveMessage({
    id: 'pending',
    threadId: f.thread.id,
    role: 'steward',
    at: '2026-11-06T10:00:00Z',
    text: '已转达',
    status: 'done',
    delegations: [
      {
        spaceId: 'shop',
        requirementId: req.id,
        messageId: 'original',
        status: 'sent',
        at: '2026-11-06T10:00:00Z',
      },
    ],
  })
  await f.stores.chat.post(req.id, {
    author: { type: 'agent', role: 'lead', harness: 'native' },
    kind: 'text',
    text: '恢复后结果',
    replyTo: 'original',
  })
  const post = vi.spyOn(f.space, 'postToLead'),
    restarted = new StewardAgent(f.deps, 'alice')
  agents.push(restarted)
  await restarted.ready
  await vi.waitFor(async () =>
    expect((await restarted.store.messages(f.thread.id))[0]?.delegations?.[0]).toMatchObject({
      status: 'replied',
      reply: '恢复后结果',
    }),
  )
  expect(post).not.toHaveBeenCalled()
})
it('配置逆 patch 恢复修改前字段，包括删除新增键', async () => {
  const f = await fixture(),
    old = structuredClone(f.stores.config.project)
  bindCrudServices(f.stores, {
    workflowEdit: async () => ({}),
    workflowConvert: async () => ({}),
    configPatch: async (patch) => {
      for (const [key, value] of Object.entries(patch.project as Record<string, unknown>)) {
        if (value === null)
          delete (f.stores.config.project as unknown as Record<string, unknown>)[key]
        else Object.assign(f.stores.config.project, { [key]: value })
      }
      return f.stores.config
    },
  })
  const p = await f.agent.proposals.create(f.thread.id, '配置', '测试', [
    {
      kind: 'command',
      spaceId: 'shop',
      commandId: 'config.patch',
      input: { patch: { project: { name: 'changed', color: 'blue' } } },
    },
  ])
  expect(
    (await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' }))
      .status,
  ).toBe('applied')
  expect((await f.agent.proposals.undo(p.id, { type: 'human', id: 'alice' })).status).toBe(
    'reverted',
  )
  expect(f.stores.config.project).toEqual(old)
})
it('config.patch 待批期间有人改了成员：批准 409 并标 stale，不覆盖别人加的成员；预览按成员列出增删', async () => {
  const f = await fixture()
  f.stores.config.members = [{ id: 'owner', name: 'owner', role: 'owner' }, { id: 'alice', name: '爱丽丝', role: 'maintainer' }]
  const step = (members: unknown[]): ProposalStep => ({ kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { members } } })
  const bob = { id: 'bob', name: 'bob', role: 'member', duties: ['qa'] }
  const p = await f.agent.proposals.create(f.thread.id, '添加成员 bob', '用户要求', [step([...f.stores.config.members!, bob])])
  expect(p.previews?.[0]).toMatchObject({ kind: 'diff' })
  expect(p.previews![0]!.body.split('\n')).toEqual(['@@ 成员（members） @@', '+ bob · member · qa', '  另外 2 名成员不变'])
  // 队友在设置页加了 carol
  f.stores.config.members = [...f.stores.config.members!, { id: 'carol', name: 'carol', role: 'viewer' }]
  await expect(f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('members') })
  expect((await f.agent.store.proposal(p.id)).status).toBe('stale')
  expect(f.stores.config.members!.map((m) => m.id)).toEqual(['owner', 'alice', 'carol'])
  // 改的是补丁没碰的键（预算）不算基线变化；基于最新成员重新生成的提案照常执行
  const next = await f.agent.proposals.create(f.thread.id, '添加成员 bob', '用户要求', [step([...f.stores.config.members!, bob])])
  f.stores.config.budget = { tokens: 1000 }
  expect((await f.agent.proposals.approve(next.id, { hash: next.hash }, { type: 'human', id: 'alice' })).status).toBe('applied')
  expect(f.stores.config.members!.map((m) => m.id)).toEqual(['owner', 'alice', 'carol', 'bob'])
})
it('同一提案里两步 config.patch：后一步不因前一步改了配置而被判基线变化', async () => {
  const f = await fixture()
  const p = await f.agent.proposals.create(f.thread.id, '改配置', '用户要求', [
    { kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { lessons: { enabled: false } } } },
    { kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { lessons: { enabled: true } } } },
  ])
  expect((await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' })).status).toBe('applied')
})
it('旧 config.patch 提案缺少基线时拒绝执行；编辑提案不能绕过原有成员基线', async () => {
  const f = await fixture()
  const step: ProposalStep = { kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { members: [{ id: 'alice', name: 'Alice', role: 'owner' }] } } }
  const legacy = await f.agent.proposals.create(f.thread.id, '旧提案', '测试', [step])
  delete (legacy.steps[0] as Extract<ProposalStep, { kind: 'command' }>).input.baseHash
  legacy.hash = proposalHash(legacy.steps)
  await f.agent.store.saveProposal(legacy)
  await expect(f.agent.proposals.approve(legacy.id, { hash: legacy.hash }, { type: 'human', id: 'alice' })).rejects.toMatchObject({ status: 409 })
  const edited = await f.agent.proposals.create(f.thread.id, '添加成员', '测试', [step])
  f.stores.config.members = [{ id: 'carol', name: 'Carol', role: 'viewer' }]
  await expect(f.agent.proposals.approve(edited.id, { hash: edited.hash, steps: [step] }, { type: 'human', id: 'alice' })).rejects.toMatchObject({ status: 409 })
  expect(f.stores.config.members.map((m) => m.id)).toEqual(['carol'])
})
it('两步 config.patch 执行期间有人新增成员：第二步不跳过基线，不覆盖成员', async () => {
  const f = await fixture()
  f.stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }]
  let calls = 0
  bindCrudServices(f.stores, {
    workflowEdit: async () => ({}), workflowConvert: async () => ({}),
    configPatch: async (patch) => {
      Object.assign(f.stores.config, patch)
      if (++calls === 1) f.stores.config.members!.push({ id: 'carol', name: 'Carol', role: 'viewer' })
      return f.stores.config
    },
  })
  const p = await f.agent.proposals.create(f.thread.id, '两步修改', '测试', [
    { kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { lessons: { enabled: false } } } },
    { kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { members: [...f.stores.config.members, { id: 'bob', name: 'Bob', role: 'member' }] } } },
  ])
  expect((await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' })).status).toBe('failed')
  expect(f.stores.config.members.map((m) => m.id)).toEqual(['alice', 'carol'])
})
it('空间总览的汇报只含本空间，已读只记在该空间上，不影响全局汇报', async () => {
  const f = await fixture(),
    req = await f.stores.workspaces.createRequirement({ title: '新需求' })
  f.clock(new Date(Date.parse(req.createdAt) + 120000).toISOString())
  expect((await buildDigest(f.deps, f.agent.store, undefined, true, true, 'shop')).progress.map((p) => p.requirementId)).toEqual([req.id])
  expect((await buildDigest(f.deps, f.agent.store, undefined, true, true, 'other')).progress).toEqual([])
  await buildDigest(f.deps, f.agent.store, undefined, true, false, 'shop')
  expect((await buildDigest(f.deps, f.agent.store, undefined, true, true, 'shop')).progress).toEqual([])
  expect((await buildDigest(f.deps, f.agent.store, undefined, true, true)).progress).toHaveLength(1)
  await buildDigest(f.deps, f.agent.store)
  expect((await buildDigest(f.deps, f.agent.store, undefined, true, true)).progress).toEqual([])
})
it('未到 since 的历史进展排除，静音不通知但保留风险', async () => {
  const f = await fixture(),
    req = await f.stores.workspaces.createRequirement({ title: '历史' })
  f.clock(new Date(Date.parse(req.createdAt) + 120000).toISOString())
  const digest = await buildDigest(
    f.deps,
    f.agent.store,
    new Date(Date.parse(req.createdAt) + 60000).toISOString(),
  )
  expect(digest.progress).toEqual([])
  await f.agent.store.write('prefs.json', {
    trust: 'confirm',
    digestTimes: [],
    mutedSpaces: ['shop'],
  })
  f.deps.extraRisks = async () => [
    {
      key: 'knowledge:shop//kb',
      kind: 'knowledge',
      level: 'medium',
      spaceId: 'shop',
      title: '库过期',
      detail: '',
      evidence: [],
      actions: [],
      firstSeenAt: req.createdAt,
      lastSeenAt: req.createdAt,
    },
  ]
  expect(await refreshRisks(f.deps, f.agent.store)).toHaveLength(1)
  expect(await f.agent.store.lines('feed.jsonl')).toEqual([])
})
it('汇报指标只保留有活动且变化显著的 token 变化并按幅度排序', async () => {
  const f = await fixture()
  const actor = { type: 'system' as const, id: 'metric' }
  async function space(id: string, name: string) {
    const stores = id === 'shop' ? f.stores : await initProject(join(f.root, id), { name })
    const req = await stores.workspaces.createRequirement({ title: name })
    const run: RunState = { runId: `run-${id}`, requirementId: req.id, workflowId: 'wf', workflowVersion: '1', status: 'running', startedAt: '2026-11-06T10:05:00.000Z', args: {}, expansions: [], nodes: {} }
    await stores.runs.create(run, { id: 'wf', title: 'wf', version: '1', stages: [], nodes: [{ id: 'n', kind: 'task', title: '节点', needs: [] }] })
    return { id, name, stores, runId: run.runId }
  }
  const quiet = await space('quiet', '无活动')
  const small = await space('small', '小波动')
  const medium = await space('medium', '中变化')
  const large = await space('large', '大变化')
  const spaces = [quiet, small, medium, large]
  f.deps.spaces = async () => spaces.map((s) => ({ id: s.id, name: s.name, requirements: 1, active: 1 }))
  f.deps.open = async (id) => ({ stores: spaces.find((s) => s.id === id)!.stores }) as never
  vi.useFakeTimers()
  for (const s of spaces) {
    vi.setSystemTime(new Date('2026-11-06T09:10:00.000Z'))
    await s.stores.events.append(s.runId, { type: 'harness.usage', actor, nodeId: 'n', data: { inputTokens: 10000, outputTokens: 0 } })
  }
  for (const [s, tokens] of [[quiet, 50000], [small, 11000], [medium, 20000], [large, 40000]] as const) {
    vi.setSystemTime(new Date('2026-11-06T10:10:00.000Z'))
    if (s !== quiet) await s.stores.events.append(s.runId, { type: 'node.started', actor, nodeId: 'n', data: { attempt: 1 } })
    await s.stores.events.append(s.runId, { type: 'harness.usage', actor, nodeId: 'n', data: { inputTokens: tokens, outputTokens: 0 } })
  }
  vi.useRealTimers()
  f.clock('2026-11-06T11:00:00.000Z')
  const digest = await buildDigest(f.deps, f.agent.store, '2026-11-06T10:00:00.000Z', false, true)
  expect(digest.metrics).toEqual([
    { spaceId: 'large', label: 'Token 用量比上个窗口上涨', value: '40000', delta: '30000' },
    { spaceId: 'medium', label: 'Token 用量比上个窗口上涨', value: '20000', delta: '10000' },
  ])
})
it('知识库草稿可低风险自动创建，并经审计命令删除撤销', async () => {
  const f = await fixture(),
    bases = new Map<string, KnowledgeBase>(),
    audit = vi.fn(async () => {})
  const remove = vi.fn(async (id: string) => {
    bases.delete(id)
  })
  f.stores.kb = {
    kinds: () => [],
    list: async () => [...bases.values()],
    get: async (id: string) => bases.get(id),
    remove,
    create: async (input: Partial<KnowledgeBase>) => {
      const kb = { ...input, id: 'kb-1', status: 'draft', version: 0 } as KnowledgeBase
      bases.set(kb.id, kb)
      return kb
    },
  } as unknown as KnowledgeStore
  f.space.commands = stewardUndoCommands(
    f.stores,
    createCommandRegistry({ stores: f.stores, audit: async () => {} }),
    audit,
  )
  await f.agent.store.write('prefs.json', { trust: 'auto-low', digestTimes: [] })
  const p = await f.agent.proposals.create(f.thread.id, '创建知识库', '测试', [
    {
      kind: 'command',
      spaceId: 'shop',
      commandId: 'knowledge.create',
      input: { name: '文档', kind: 'rag', config: {} },
    },
  ])
  expect(p).toMatchObject({ status: 'applied', auto: true, risk: 'low' })
  expect(bases.has('kb-1')).toBe(true)
  expect((await f.agent.proposals.undo(p.id, { type: 'human', id: 'alice' })).status).toBe(
    'reverted',
  )
  expect(remove).toHaveBeenCalledWith(
    'kb-1',
    { type: 'human', id: 'alice' },
    expect.stringContaining('撤销管家提案'),
  )
  expect(audit).toHaveBeenCalled()
  expect(bases.size).toBe(0)
})
it('知识库工具只在空间挂载知识库时提供', async () => {
  const f = await fixture()
  expect((await f.agent.tools.specs()).some((s) => s.name === 'knowledge_search')).toBe(false)
  f.stores.kb = {
    route: async () => ({
      hits: [{ ref: 'docs/a#1', title: '文档', baseId: 'kb', score: 1 }],
      bases: [{ id: 'kb', version: 1 }],
      latencyMs: 1,
      tokens: 2,
    }),
  } as unknown as KnowledgeStore
  expect((await f.agent.tools.specs()).some((s) => s.name === 'knowledge_search')).toBe(true)
  const result = await f.agent.tools.call(
    'knowledge_search',
    { spaceId: 'shop', text: '业务' },
    { threadId: f.thread.id, messageId: 'm', proposals: [], delegations: [] },
  )
  expect(result.citations[0]?.href).toBe('/s/shop/knowledge/kb')
})
it('危险命令永不自动执行，删除还需要名称确认', async () => {
  const f = await fixture(),
    calls = vi.fn(async () => ({}))
  f.space.commands = createCommandRegistry({
    stores: f.stores,
    audit: async () => {},
    extensions: [
      {
        id: 'test.delete',
        title: '删除',
        risk: 'dangerous',
        kind: 'command',
        input: { type: 'object', required: ['id'] },
        handler: calls,
      },
    ],
  })
  await f.agent.store.write('prefs.json', { trust: 'auto-low', digestTimes: [] })
  const unconfirmed = await f.agent.proposals.create(f.thread.id, '删除', '测试', [
    {
      kind: 'command',
      spaceId: 'shop',
      commandId: 'test.delete',
      input: { id: 'target', confirm: 'target' },
    },
  ])
  await expect(
    f.agent.proposals.approve(
      unconfirmed.id,
      { hash: unconfirmed.hash },
      { type: 'human', id: 'alice' },
    ),
  ).rejects.toThrow('手动输入')
  const p = await f.agent.proposals.create(f.thread.id, '删除', '测试', [
    {
      kind: 'command',
      spaceId: 'shop',
      commandId: 'test.delete',
      input: { id: 'target', confirm: 'target' },
    },
  ])
  expect(p).toMatchObject({ status: 'pending', risk: 'high' })
  expect(calls).not.toHaveBeenCalled()
})
it('流式正文透传，提案事件和建议不超过三条', async () => {
  const f = await fixture()
  let n = 0
  f.deps.chat = async (_, onToken) => {
    if (n++ === 0)
      return {
        stopReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '先准备可预览的变更。',
          toolCalls: [
            {
              id: 'p',
              name: 'propose',
              arguments: JSON.stringify({ title: '需求', summary: '测试', steps: [f.create] }),
            },
          ],
        },
      }
    onToken?.('提案')
    onToken?.('已准备[1]。')
    return { stopReason: 'end', message: { role: 'assistant', content: '提案已准备[1]。' } }
  }
  const agent = new StewardAgent(f.deps, 'alice')
  agents.push(agent)
  const events: Array<{ type: string }> = []
  agent.store.onThread(f.thread.id, (event) => events.push(event))
  const result = await agent.ask({ text: '创建需求' }, f.thread.id)
  expect(result).toMatchObject({ status: 'done', thinking: '先准备可预览的变更。' })
  expect(result.proposalIds).toHaveLength(1)
  expect(result.suggestions!.length).toBeLessThanOrEqual(3)
  expect(events.filter((e) => e.type === 'delta')).toHaveLength(2)
  expect(events.some((e) => e.type === 'proposal')).toBe(true)
})

it.each([
  '.TAKT/knowledge/queries.jsonl',
  '.Takt/steward/bob/thread.json',
  '.env',
  '.env.local',
  '.git/config',
  '.steward/bob/prefs.json',
])('M4-1：禁止读取敏感路径 %s', async (path) => {
  const f = await fixture()
  await expect(readStewardFile(f.stores.projectDir, path)).rejects.toThrow('非敏感')
})
it('M4-6：一小时 snooze 到期再次提醒', async () => {
  const f = await fixture()
  f.deps.extraRisks = async () => [
    {
      key: 'shop:test',
      spaceId: 'shop',
      kind: 'knowledge',
      level: 'medium',
      title: '失败',
      summary: '失败',
      evidence: [],
    },
  ]
  await refreshRisks(f.deps, f.agent.store)
  await setRiskState(f.deps, f.agent.store, 'shop:test', {
    state: 'snoozed',
    until: '2026-11-06T11:00:00Z',
  })
  f.clock('2026-11-06T11:01:00Z')
  await refreshRisks(f.deps, f.agent.store)
  expect(
    (await f.agent.store.lines<{ type: string }>('feed.jsonl')).filter(
      (item) => item.type === 'risk',
    ),
  ).toHaveLength(2)
})
it('M4-7：发布门槛拒绝使提案失败', async () => {
  const f = await fixture()
  f.stores.kb = {
    get: async () => ({ id: 'docs' }),
    publish: async () => ({
      base: { id: 'docs' },
      gate: { pass: false, reasons: ['Recall 退化'] },
    }),
  } as unknown as KnowledgeStore
  const proposal = await f.agent.proposals.create(f.thread.id, '发布', '检查', [
    { kind: 'command', spaceId: 'shop', commandId: 'knowledge.publish', input: { id: 'docs' } },
  ])
  expect(
    await f.agent.proposals.approve(
      proposal.id,
      { hash: proposal.hash },
      { type: 'human', id: 'alice' },
    ),
  ).toMatchObject({ status: 'failed' })
})
it('M4-8：连接配置与运行中的 workflow 为 high，auto-low 不执行', async () => {
  const f = await fixture()
  await f.agent.store.write('prefs.json', { trust: 'auto-low', digestTimes: [] })
  const proposal = await f.agent.proposals.create(f.thread.id, '连接', '检查', [
    {
      kind: 'command',
      spaceId: 'shop',
      commandId: 'knowledge.create',
      input: { kind: 'database', name: 'db', config: { connection: 'secret:db' } },
    },
  ])
  expect(proposal).toMatchObject({ risk: 'high', status: 'pending' })
  vi.spyOn(f.stores.runs, 'list').mockResolvedValue([
    { workflowId: 'flow', status: 'waiting_human' },
  ] as RunState[])
  expect(
    await f.agent.proposals.validate([
      { kind: 'workflow', spaceId: 'shop', workflowId: 'flow', baseRev: 'r1', edits: [{ op: 'setMeta', key: 'title', value: '交付流程' }] },
    ]),
  ).toMatchObject({ risk: 'high' })
})

it('M5：taken 回执不是回答，随后 replied；发送错误为 uncertain，显式重发需原因', async () => {
  const f = await fixture()
  await f.stores.workspaces.createRequirement({ id: 'REQ-001', title: '回执' })
  const context = { threadId: f.thread.id, messageId: 'm', proposals: [], delegations: [] as StewardDelegation[], onDelegation: vi.fn(async () => {}) }
  const result = await f.agent.tools.call('ask_lead', { spaceId: 'shop', requirementId: 'REQ-001', message: '处理' }, context)
  const reply: RoomMessage = { id: 'taken', seq: 1, roomId: 'REQ-001', at: '2026-11-06T10:01:00Z', kind: 'system', text: '接手', author: { type: 'agent', role: 'lead', harness: 'mock' }, replyTo: 'sent-1', receipt: { status: 'taken' } }
  for (const listener of f.listeners) listener(reply)
  await vi.waitFor(() => expect(result.data).toMatchObject({ status: 'taken' }))
  expect((result.data as StewardDelegation).reply).toBeUndefined()
  for (const listener of f.listeners) listener({ ...reply, id: 'replied', kind: 'text', text: '完成', receipt: { status: 'replied' } })
  await vi.waitFor(() => expect(result.data).toMatchObject({ status: 'replied', reply: '完成' }))
  await expect(f.agent.tools.resendDelegation('sent-1', '重复')).rejects.toThrow('仅不确定')
  const post = vi.spyOn(f.space, 'postToLead').mockRejectedValueOnce(new Error('network'))
  const uncertain = (await f.agent.tools.call('ask_lead', { spaceId: 'shop', requirementId: 'REQ-001', message: '可能送达' }, context)).data as StewardDelegation
  expect(uncertain.status).toBe('uncertain')
  expect(post).toHaveBeenCalledTimes(1)
  await expect(f.agent.tools.resendDelegation(uncertain.messageId, '')).rejects.toThrow('原因')
  post.mockResolvedValueOnce('resent-2')
  expect(await f.agent.tools.resendDelegation(uncertain.messageId, '人工核对未送达')).toMatchObject({ status: 'sent', messageId: 'resent-2' })
  expect(await f.agent.store.lines('delegation-audit.jsonl')).toHaveLength(1)
})
it('M5：未接手 30 分钟过期，旧 answered/failed 归一并持久回读', async () => {
  const f = await fixture()
  await f.stores.workspaces.createRequirement({ id: 'REQ-001', title: '旧回执' })
  await f.agent.store.saveMessage({ id: 'legacy', threadId: f.thread.id, role: 'steward', text: '旧数据', at: '2026-11-06T10:00:00Z', delegations: [
    { spaceId: 'shop', requirementId: 'REQ-001', messageId: 'answered', status: 'answered', at: '2026-11-06T10:00:00Z' },
    { spaceId: 'shop', requirementId: 'REQ-001', messageId: 'failed', status: 'failed', at: '2026-11-06T10:00:00Z' },
    { spaceId: 'shop', requirementId: 'REQ-001', messageId: 'sent', status: 'sent', at: '2026-11-06T10:00:00Z' },
  ] })
  const post = vi.spyOn(f.space, 'postToLead')
  f.clock('2026-11-06T10:30:00Z')
  const results = await f.agent.tools.refreshDelegations()
  expect(new Map(results.map(item => [item.messageId, item.status]))).toEqual(new Map([['answered', 'replied'], ['failed', 'uncertain'], ['sent', 'expired']]))
  expect((await f.agent.store.messages(f.thread.id))[0]!.delegations!.map(item => item.status)).toEqual(['replied', 'uncertain', 'expired'])
  expect(post).not.toHaveBeenCalled()
})

it('M8：digest 按空间与需求折叠为最新进展，摘要使用去重条数', async () => {
  const f = await fixture()
  const first = await f.stores.workspaces.createRequirement({ title: '第一项' })
  const second = await f.stores.workspaces.createRequirement({ title: '第二项' })
  await f.stores.workspaces.updateRequirement(first.id, { status: 'delivered' })
  f.clock('2099-01-01T00:00:00Z')
  const digest = await buildDigest(f.deps, f.agent.store, undefined, false, true)
  expect(digest.progress).toHaveLength(2)
  const collapsed = digest.progress.find(item => item.requirementId === first.id)!
  expect(collapsed).toMatchObject({ kind: 'delivered', more: 1 })
  expect(digest.progress.map(item => item.at)).toEqual([...digest.progress.map(item => item.at)].sort().reverse())
  expect(digest.progress.some(item => item.requirementId === second.id)).toBe(true)
  expect(digest.summary).toContain('2 项进展')
})

it('M8：只给需求编号的引用补全真实标题，删除会话后迟到回执仍保留动态', async () => {
  const f = await fixture()
  const req = await f.stores.workspaces.createRequirement({ title: '真实需求标题' })
  const thread = await f.agent.store.createThread('转达', new Date().toISOString(), [{ type: 'requirement', id: req.id, spaceId: 'shop' }])
  expect(thread).toMatchObject({ spaceId: 'shop', requirementId: req.id, requirementTitle: '真实需求标题' })
  await f.agent.store.write(`delegations/${sha256('late')}.json`, {
    threadId: thread.id, text: '查询', sentAt: '2020-01-01T00:00:00Z',
    delegation: { spaceId: 'shop', requirementId: req.id, messageId: 'late', status: 'sent', at: '2020-01-01T00:00:00Z' },
  })
  await f.agent.store.deleteThread(thread.id)
  await f.agent.tools.refreshDelegations()
  expect(await f.agent.store.read(`threads/${thread.id}.json`)).toBeUndefined()
  expect(await f.agent.store.lines('feed.jsonl')).toContainEqual(expect.objectContaining({ type: 'delegation', threadId: thread.id }))
})

it('停止正在写的回复：harness 收到中止信号，消息是「已停止」并留下写出的部分，会话不算出错', async () => {
  const f = await fixture()
  let started!: () => void
  const running = new Promise<void>((resolve) => { started = resolve })
  const agent = new StewardAgent({ ...f.deps, resolveRuntime: async () => ({ run: async (turn) => {
    turn.onEvent({ type: 'message', role: 'assistant', text: '先看一下' })
    started()
    await new Promise((_, reject) => turn.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    return ''
  } }) }, 'alice')
  agents.push(agent)
  const { thread, done } = await agent.post({ text: '帮我看看进度' })
  await running
  expect(agent.stop(thread.id)).toBe(true)
  const message = await done
  expect(message).toMatchObject({ status: 'stopped', text: '先看一下' })
  expect(message.error).toBeUndefined()
  expect((await agent.store.thread(thread.id)).status).toBeUndefined()
  expect(agent.stop(thread.id)).toBe(false)
})

it('服务重启：上次没写完的回复标成已停止，页面不会一直显示它在跑', async () => {
  const f = await fixture()
  await f.agent.store.saveMessage({ id: 'm1', threadId: f.thread.id, role: 'steward', at: '2026-11-06T10:00:00Z', text: '写了一半', status: 'streaming' })
  await f.agent.store.setStatus(f.thread.id, 'replying')
  const restarted = new StewardAgent(f.deps, 'alice')
  agents.push(restarted)
  await restarted.ready
  expect((await restarted.store.messages(f.thread.id)).find((m) => m.id === 'm1')).toMatchObject({ status: 'stopped', text: '写了一半', error: '服务重启时这条回复还没写完' })
  expect((await restarted.store.thread(f.thread.id)).status).toBe('interrupted')
})

it('运行时给出的可读原因原样显示，不再套「回复失败…请检查管家配置」', async () => {
  const f = await fixture()
  const agent = new StewardAgent({ ...f.deps, resolveRuntime: async () => ({ run: async () => { throw new StewardError(502, 'TRAE CLI 的上游模型现在太忙，等一会儿点「重试」，或换一个模型') } }) }, 'alice')
  agents.push(agent)
  const { done } = await agent.post({ text: '进度' })
  expect(await done).toMatchObject({ status: 'error', error: 'TRAE CLI 的上游模型现在太忙，等一会儿点「重试」，或换一个模型' })
})

it('失败回滚 config.patch 也检查基线，不删除执行后队友新增的成员', async () => {
  const f = await fixture()
  f.stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }]
  let calls = 0
  bindCrudServices(f.stores, {
    workflowEdit: async () => ({}), workflowConvert: async () => ({}),
    configPatch: async (patch) => {
      if (++calls === 2) throw new Error('第二步失败')
      Object.assign(f.stores.config, patch)
      f.stores.config.members!.push({ id: 'carol', name: 'Carol', role: 'viewer' })
      return f.stores.config
    },
  })
  const p = await f.agent.proposals.create(f.thread.id, '两步配置', '测试', [
    { kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { members: [...f.stores.config.members, { id: 'bob', name: 'Bob', role: 'member' }] } } },
    { kind: 'command', spaceId: 'shop', commandId: 'config.patch', input: { patch: { lessons: { enabled: false } } } },
  ])
  const result = await f.agent.proposals.approve(p.id, { hash: p.hash }, { type: 'human', id: 'alice' })
  expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('回滚失败') })
  expect(f.stores.config.members.map(m => m.id)).toEqual(['alice', 'bob', 'carol'])
  expect(proposalHash(result.steps)).toBe(result.hash)
})
