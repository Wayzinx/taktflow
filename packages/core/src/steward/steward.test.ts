import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import { createCommandRegistry } from '../commands/index.js'
import { bindCrudServices } from '../commands/crud-commands.js'
import type { CommandAudit, CommandSpec } from '../commands/contracts.js'
import type { RoomMessage, ChatResponse, RunState } from '../types.js'
import type { ProposalStep, WorkflowDocument, StewardDelegation } from '../api.js'
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
    '帮我检查 商店 的知识库设置',
  ])
  expect(await stewardSuggestions(f.deps, 'settings-members', 'shop')).toEqual([
    '帮我检查 商店 的成员设置',
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
        calls.push(String(input.spaceId))
        return { data: { requirements: [], runs: [], attention: [] }, citations: [], summary: '' }
      },
    )
  expect(calls).toEqual(['shop', 'shop'])
})
afterEach(async () => {
  agents.splice(0).forEach((agent) => agent.close())
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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
      if (id !== 'shop') throw new Error('空间不存在')
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
    expect(result.tools?.[0]?.summary).toContain('字段名必须是 kind')
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
    await vi.waitFor(async () => expect(await f.agent.store.lines('feed.jsonl')).toHaveLength(1))
    expect(updated[1]?.status).toBe('answered')
    expect(f.listeners.size).toBe(0)
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
    expect([...thread.title]).toHaveLength(20)
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
    const f = await fixture(),
      req = await f.stores.workspaces.createRequirement({ title: '窗口内' })
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
      status: 'answered',
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
