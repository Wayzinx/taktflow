import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProject, type ArtifactRef, type AttentionItem, type CommandHandlers, type ProjectStores, type SpaceMember } from '@taktflow/core'
import { afterEach, expect, it, vi } from 'vitest'
import { answerAttention, projectCommands } from './commands.js'
import { feishuAttentionCard, handleFeishuEvent, type FeishuActionContext, type FeishuMessage } from './feishu-actions.js'
import type { FeishuEvent } from './feishu-wire.js'
import { createServer } from './index.js'
import { initSpace } from './space-admin.js'
import { teamRoomStore } from './team-room-store.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const base = 'https://hub.example'
const chat = 'oc_team'
const revision = 'binding-rev-1'
const members: SpaceMember[] = [
  { id: 'alice', name: 'Alice', role: 'owner' }, { id: 'bob', name: 'Bob', role: 'member' }, { id: 'viewer', name: 'Viewer', role: 'viewer' },
]
type Button = { text: { content: string }; value?: Record<string, string>; url?: string }

const message = (id: string, text: string): FeishuEvent => ({ kind: 'message', id, chatId: chat, openId: 'wire-user', text })
const action = (id: string, value: Record<string, string>, chatId = chat): FeishuEvent => ({ kind: 'action', id, chatId, openId: 'wire-user', value })
const responseText = (message: FeishuMessage) => String(message.content.text)
function buttons(message: FeishuMessage) {
  expect(message.type).toBe('interactive')
  expect(message.content.schema).toBe('2.0')
  type CardButton = { text: Button['text']; behaviors: Array<{ type: string; value?: Record<string, string>; default_url?: string }> }
  const body = message.content.body as { elements: Array<{ columns?: Array<{ elements: CardButton[] }> }> }
  return body.elements.flatMap(element => element.columns ?? []).flatMap(column => column.elements).map(button => ({
    text: button.text, value: button.behaviors.find(action => action.type === 'callback')?.value,
    url: button.behaviors.find(action => action.type === 'open_url')?.default_url,
  }))
}

async function fixture(workflows: 'blank' | 'standard' = 'blank') {
  const root = await mkdtemp(join(tmpdir(), 'takt-feishu-actions-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const seed = await initSpace(join(root, 'alpha'), workflows)
  const setMembers = (list: SpaceMember[]) => writeFile(join(seed.projectDir, 'takt.config.json'), JSON.stringify({ ...seed.config, members: list }))
  await setMembers(members)
  const stores = await openProject(seed.projectDir)
  const startRun = vi.fn<NonNullable<CommandHandlers['startRun']>>().mockImplementation(async ({ workflowId, requirementId }) => {
    const runId = 'run-feishu'
    await stores.runs.create({ runId, workflowId, requirementId, workflowVersion: '1', status: 'running',
      startedAt: new Date().toISOString(), nodes: {}, expansions: [], args: {} }, { id: workflowId, title: workflowId, version: '1', nodes: [], stages: [] })
    return { runId }
  })
  const answer = vi.fn<NonNullable<CommandHandlers['answerAttention']>>().mockImplementation((input, context) => answerAttention(stores, input, context.actor))
  const ctx: FeishuActionContext = { bindingRevision: revision, publicBaseUrl: base, options: {
    getCommands: live => projectCommands(live, { startRun, answerAttention: answer }),
  } }
  return { root, stores, setMembers, startRun, answer, ctx, room: teamRoomStore(stores.taktDir),
    handle: (member: string, event: FeishuEvent, override: Partial<FeishuActionContext> = {}) => handleFeishuEvent(stores, member, event, { ...ctx, ...override }) }
}

it('普通群消息和 Web 共用同一会话；回放返回原管家答复且不会重复写入', async () => {
  const { stores, root, handle, room } = await fixture()
  const server = await createServer({ spacesDir: root, port: 0 })
  cleanups.push(() => server.close())
  const web = (input?: object) => fetch(`${server.url}/api/s/alpha/space/team${input ? '/messages' : ''}`, {
    method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' }, body: input ? JSON.stringify(input) : undefined,
  })
  expect((await web({ requestId: 'web-1', mode: 'chat', text: 'Web 先讨论验收目标' })).status).toBe(200)
  const event = message('im-1', '@管家   继续讨论验收')
  const response = await handle('bob', event)
  expect(responseText(response)).toContain('Web 先讨论验收目标')
  expect(await handle('bob', event)).toEqual(response)
  const data = await (await web()).json()
  expect(data.messages).toEqual(await room.messages())
  expect(data.messages.map(({ author }: { author: string }) => author)).toEqual(['alice', 'steward', 'bob', 'steward'])
  expect(await stores.workspaces.listRequirements()).toEqual([])
})

it('用锁定时的讨论和真实工作流创建草稿；不同成员选择不同流程也只启动一次', async () => {
  const { stores, handle, room, startRun } = await fixture('standard')
  await handle('alice', message('im-1', '校验失败时记录实际数据'))
  const draft = message('im-2', '把刚讨论的验收校验建成需求')
  const card = await handle('alice', draft)
  const choices = buttons(card).filter(button => button.value)
  expect(choices).toHaveLength(2)
  expect(Object.keys(choices[0]!.value!).sort()).toEqual(['card', 'token'])
  expect(await handle('alice', draft)).toEqual(card)
  expect(await stores.workspaces.listRequirements()).toEqual([])
  expect(responseText(await handle('bob', action('wrong', { ...choices[0]!.value!, token: 'forged' })))).toContain('无效')
  await handle('alice', message('im-3', '这条后来的聊天不应被纳入草稿'))
  const [first, second] = await Promise.all([
    handle('bob', action('card-1', { ...choices[0]!.value!, requirementId: 'CLIENT-SUPPLIED' })),
    handle('alice', action('card-2', choices[1]!.value!)),
  ])
  expect(first).toEqual(second)
  expect(startRun).toHaveBeenCalledTimes(1)
  const [req] = await stores.workspaces.listRequirements()
  expect(req).toMatchObject({ title: '验收校验', description: expect.stringContaining('校验失败时记录实际数据') })
  expect(req!.description).not.toContain('后来的聊天')
  expect(req!.id).toMatch(/^TEAM-/)
  expect(responseText(first)).toContain(`${base}/s/alpha/req/${req!.id}`)
  expect(responseText(first)).toContain(`${base}/s/alpha/run/run-feishu`)
  const history = await room.messages()
  expect(history.filter(turn => turn.text.startsWith('确认需求草稿'))).toHaveLength(1)
  expect(history.at(-1)).toMatchObject({ requirementId: req!.id, runId: 'run-feishu' })
  const [, command] = startRun.mock.calls[0]!
  expect(command.actor).toEqual({ type: 'human', id: history.at(-2)!.author })
})

it('每次确认重读成员角色并核对群、空间、绑定；移除工作流不能确认旧选项', async () => {
  const { root, stores, ctx, handle, setMembers, startRun, room } = await fixture('standard')
  const card = await handle('alice', message('im-1', '建需求：新规则\n验收条件'))
  const choice = buttons(card).find(button => button.value?.token && button.text.content.includes('轻量'))!.value!
  const gesture = action('confirm', choice)
  const beta = await initSpace(join(root, 'beta'), 'blank')
  await writeFile(join(beta.projectDir, 'takt.config.json'), JSON.stringify({ ...beta.config, members }))
  expect(responseText(await handleFeishuEvent(beta, 'alice', gesture, ctx))).toContain('无效')
  expect(responseText(await handle('alice', action('confirm', choice, 'other-chat')))).toContain('无效')
  expect(responseText(await handle('alice', gesture, { bindingRevision: 'new-binding' }))).toContain('无效')
  expect(responseText(await handle('viewer', message('im-2', '不可写入')))).toContain('当前空间成员')
  await setMembers(members.map(member => member.id === 'bob' ? { ...member, role: 'viewer' } : member))
  expect(responseText(await handle('bob', gesture))).toContain('当前空间成员')
  await rm(join(stores.paths.workflows, 'quick-fix.workflow.ts'))
  expect(responseText(await handle('alice', gesture))).toContain('已不在空间的可选列表')
  expect(await room.messages()).toHaveLength(2)
  expect(startRun).not.toHaveBeenCalled()
})

async function seedAttention(stores: ProjectStores, form: AttentionItem['form'], bound = false) {
  const requirementId = `REQ-${form}`
  const runId = `run-${form}`
  const nodeId = 'signoff'
  const requestId = `${runId}:${nodeId}`
  await stores.workspaces.createRequirement({ id: requirementId, title: form })
  const ref: ArtifactRef = { workspace: requirementId, path: 'inputs/prd.md' }
  if (bound) await stores.workspaces.writeArtifact({ ref, content: 'v1', kind: 'input', author: { type: 'human', id: 'alice' }, reason: '提交审批' })
  await stores.runs.create({ runId, workflowId: 'delivery', workflowVersion: '1', requirementId, status: 'waiting_human', startedAt: new Date().toISOString(),
    nodes: { [nodeId]: { id: nodeId, status: 'waiting_human', attempts: 1, outputs: [] } }, expansions: [], args: {},
  }, { id: 'delivery', title: '审批', version: '1', stages: [], nodes: [] })
  return stores.attention.create({ runId, requirementId, nodeId, requestId, ask: '请确认验收清单', form, ...(bound ? { boundTo: [{ ...ref, version: 1 }] } : {}) })
}

it('待办卡和通知卡共用实际审批及审计；自由回答跳 Web，跨卡重复不二次执行', async () => {
  const { stores, handle, answer, room } = await fixture()
  const approval = await seedAttention(stores, 'approve')
  const freeForm = await seedAttention(stores, 'answer')
  expect(await feishuAttentionCard(stores, revision, base, freeForm.requestId)).toBeUndefined()
  const notice = (await feishuAttentionCard(stores, revision, base, approval.requestId, chat))!
  const queue = await handle('alice', message('todo', '@管家 待办'))
  expect(buttons(queue).find(button => button.text.content === '去 Web 回答')?.url).toBe(`${base}/s/alpha/attention`)
  const approve = buttons(notice).find(button => button.text.content === '批准')!.value!
  const reject = buttons(queue).find(button => button.text.content === '拒绝')!.value!
  const result = await handle('bob', action('approval-1', approve))
  expect(responseText(result)).toContain('已批准')
  expect(responseText(result)).toContain(`${base}/s/alpha/run/${approval.runId}`)
  expect(await handle('alice', action('approval-2', reject))).toEqual(result)
  expect(answer).toHaveBeenCalledExactlyOnceWith({ requestId: approval.requestId, decision: 'approve' },
    { actor: { type: 'human', id: 'bob' }, reason: '飞书群人工处理待办' })
  expect((await stores.attention.list()).find(item => item.requestId === approval.requestId)).toMatchObject({ decision: 'approve', answeredBy: { type: 'human', id: 'bob' } })
  expect(await feishuAttentionCard(stores, revision, base, approval.requestId)).toBeUndefined()
  const audit = await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')
  expect(audit).toContain('attention.answer')
  expect((await room.messages()).map(({ author, runId }) => ({ author, runId }))).toEqual([{ author: 'bob' }, { author: 'steward', runId: approval.runId }])
})

it('产物新版本和 Web 已处理状态都阻止旧卡再次提交', async () => {
  const { stores, handle, answer, room } = await fixture()
  const approval = await seedAttention(stores, 'approve', true)
  const card = (await feishuAttentionCard(stores, revision, base, approval.requestId))!
  const approve = buttons(card)[0]!.value!
  await stores.workspaces.writeArtifact({ ref: { workspace: approval.requirementId, path: 'inputs/prd.md' }, content: 'v2', kind: 'input',
    author: { type: 'human', id: 'alice' }, reason: '修改审批对象' })
  expect(responseText(await handle('bob', action('stale', approve)))).toContain('审批对象已变化')
  expect(await feishuAttentionCard(stores, revision, base, approval.requestId)).toBeUndefined()
  await answerAttention(stores, { requestId: approval.requestId, decision: 'reject' }, { type: 'human', id: 'alice' })
  expect(responseText(await handle('bob', action('web-already-answered', approve)))).toContain('待办已处理')
  expect(await room.messages()).toEqual([])
  expect(answer).not.toHaveBeenCalled()
})

it('流程提交落盘后即使回复回执未完成，也只恢复运行链接而不重启', async () => {
  const { stores, handle, room, startRun } = await fixture('standard')
  const card = await handle('alice', message('draft', '建需求 恢复测试'))
  const choices = buttons(card).flatMap(button => button.value ? [button.value] : [])
  await handle('alice', action('first', choices[0]!))
  const roomFile = join(stores.taktDir, 'chat', '.team-room.json')
  const persisted = JSON.parse(await readFile(roomFile, 'utf8')) as {
    receipts: Record<string, { id: string; finished?: boolean }>; messages: Awaited<ReturnType<typeof room.messages>>
  }
  const confirmation = persisted.messages.at(-2)!
  delete Object.values(persisted.receipts).find(receipt => receipt.id === confirmation.id)!.finished
  persisted.messages.pop()
  await writeFile(roomFile, JSON.stringify(persisted))
  const recovered = await handle('bob', action('after-interruption', choices[1]!))
  expect(responseText(recovered)).toContain(`${base}/s/alpha/run/run-feishu`)
  expect(responseText(recovered)).toContain('不会重复启动')
  expect(await room.messages()).toHaveLength(4)
  expect(startRun).toHaveBeenCalledTimes(1)
})

it('取消的工作流或已经被替换的审批不推送，旧卡不能回答新审批', async () => {
  const { stores, handle, answer } = await fixture()
  const approval = await seedAttention(stores, 'approve')
  const card = (await feishuAttentionCard(stores, revision, base, approval.requestId))!
  const approve = buttons(card)[0]!.value!
  const { createdAt: _createdAt, ...fields } = approval
  const replacement = await stores.attention.create({ ...fields, requestId: `${approval.requestId}#2` })
  expect(await feishuAttentionCard(stores, revision, base, approval.requestId)).toBeUndefined()
  expect(responseText(await handle('alice', action('superseded', approve)))).toContain('已变化')
  const replacementCard = (await feishuAttentionCard(stores, revision, base, replacement.requestId))!
  const run = (await stores.runs.get(approval.runId))!
  await stores.runs.save({ ...run, status: 'cancelled' })
  expect(await feishuAttentionCard(stores, revision, base, replacement.requestId)).toBeUndefined()
  expect(responseText(await handle('alice', action('cancelled-run', buttons(replacementCard)[0]!.value!)))).toContain('已变化')
  expect(answer).not.toHaveBeenCalled()
})
