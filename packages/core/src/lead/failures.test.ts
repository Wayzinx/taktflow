import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { createEngine } from '../engine/index.js'
import type { AgentProfile, HarnessAdapter, HarnessResult, WorkflowDefinition } from '../types.js'
import { createLeadRuntime, LeadTurnError } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const profile = (role: string): AgentProfile => ({ role, title: role, description: role, instructions: '', harness: { harness: 'mock' }, writeScope: [], skills: [] })
async function setup(turns: HarnessResult[], workflows: WorkflowDefinition[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'takt-lead-failure-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.lead = { harness: { harness: 'mock' } }
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }]
  const requirement = await stores.workspaces.createRequirement({ title: '群聊驱动 PRD 修改', owner: 'alice' })
  let index = 0
  const harness: HarnessAdapter = { id: 'mock', displayName: 'Mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async () => turns[index++]! }
  const lead = createLeadRuntime({ stores, profiles: { lead: profile('lead') }, harnesses: { mock: harness },
    engineFactory: (deps) => createEngine({ ...deps, knowledge: [] }),
    workflows: { list: async () => workflows.map((workflow) => ({ id: workflow.id, snapshot: snapshotWorkflow(workflow) })),
      load: async (id) => workflows.find((workflow) => workflow.id === id)!, get: async () => ({ source: '', rev: 'base' }), replaceSource: async () => undefined } })
  const send = async (text: string) => lead.onMessage(requirement.id, await stores.chat.post(requirement.id, { kind: 'text', author: { type: 'human', id: 'alice' }, text }))
  const system = async () => (await stores.chat.list(requirement.id)).filter((message) => message.author.type === 'system' && !['Lead 已接手', '需求已创建'].includes(message.text)).map((message) => message.text)
  return { stores, requirement, lead, send, system }
}

it('Lead 回合 harness 登录过期：群里只有一条中文、可操作的说明，Lead 灯带上失败原因，调用方不必再报', async () => {
  const expired = 'Claude Code：Failed to authenticate: OAuth session expired and could not be refreshed\nProcess exited with code 1'
  const { lead, requirement, send, system } = await setup([{ ok: false, finalText: '', error: expired }, { ok: true, finalText: '', structured: { reply: '在', actions: [] } }])
  const failure = await send('@lead 开始').catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(LeadTurnError)
  expect((failure as LeadTurnError).reported).toBe(true)
  expect((failure as Error).message).toBe('Lead 回合失败：登录或认证失败')
  const texts = await system()
  expect(texts).toHaveLength(1)
  expect(texts[0]).toMatch(/^Lead 回合失败：登录或认证失败。在本机重新登录该 harness，或到「空间设置 › 模型与 Harness」检查密钥.*\n原因：mock 登录或认证失败：Claude Code：Failed to authenticate/s)
  expect(lead.getPresence(requirement.id)).toMatchObject({ state: 'idle', detail: '上一回合失败：登录或认证失败' })
  await send('@lead 在吗')
  expect(lead.getPresence(requirement.id).detail).toBeUndefined()
}, 60_000)

it('Lead 启动运行失败时回执说清原因：没有接得住该档位的流水线', async () => {
  const chatAuto: WorkflowDefinition = { id: 'chat-auto', title: '群聊路由演示', version: '1', tiers: ['T0', 'T1'], stages: [], nodes: [{ id: 'ready', kind: 'script', title: '路由接入', run: async () => {} }] }
  const { send, system } = await setup([{ ok: true, finalText: '', structured: { reply: '按改动形状选择流程并启动。', actions: [{ type: 'start_run', workflowId: 'auto' }] } }], [chatAuto])
  const result = (await send('@lead 现在什么进度了？'))!
  expect(result.results[0]).toMatchObject({ ok: false })
  expect(await system()).toContainEqual(expect.stringMatching(/^Lead 启动运行失败：没有支持 T2 的流水线（现有：chat-auto 支持 T0\/T1）/))
})
