import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { script } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { NodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'chat', title: '群聊投影', version: '1', stages: [], nodes })
async function runEnds(nodes: NodeDef[]) {
  const root = await mkdtemp(join(tmpdir(), 'takt-chat-events-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '群聊' })
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: req.id, workflow: workflow(nodes) })
  const messages = (await stores.chat.list(req.id)).filter((message) => /^运行(结束|暂停)/.test(message.text))
  return { state, messages }
}

it('失败的运行在群聊里写明卡住的节点和原因', async () => {
  const { state, messages } = await runEnds([script({ id: 'implement', title: '实现', run: async () => { throw new Error('缺少必需输入：spec/**') } })])
  expect(state.status).toBe('failed')
  expect(messages.map((message) => [message.text, message.refs?.nodeId])).toEqual([['运行结束：失败 · implement：缺少必需输入：spec/**', 'implement']])
})

it('等人处理写成“运行暂停”而不是“运行结束”，并带上停下的原因', async () => {
  const { state, messages } = await runEnds([script({ id: 'implement', title: '实现', retry: { max: 3 }, run: async () => { throw new Error('缺少必需输入：spec/**') } })])
  expect(state.status).toBe('waiting_human')
  expect(messages.map((message) => message.text)).toEqual(['运行暂停：等人处理 · implement：同样的失败已出现 2 次：缺少必需输入：spec/**'])
})

it('成功的运行仍写“运行结束：成功”', async () => {
  const { messages } = await runEnds([script({ id: 'ok', title: '', run: async () => {} })])
  expect(messages.map((message) => message.text)).toEqual(['运行结束：成功'])
})
