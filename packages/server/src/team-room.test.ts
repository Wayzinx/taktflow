import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandRegistry, openProject, type CommandHandlers } from '@taktflow/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type RunningServer, type ServerOptions } from './index.js'
import { initSpace } from './space-admin.js'
import { spaceId } from './space.js'
import type { TeamJob } from './team-room.js'
import type { TeamMessage } from './team-room-store.js'

const hub = vi.hoisted(() => ({ teamNodes: vi.fn(), teamJobs: vi.fn(), enqueueTeamJob: vi.fn() }))
vi.mock('./team-hub.js', () => hub)

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  for (const mock of Object.values(hub)) mock.mockReset()
  hub.teamNodes.mockResolvedValue([])
  hub.teamJobs.mockResolvedValue([])
})
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop() })

type Snapshot = { messages: TeamMessage[]; nodes: unknown[]; jobs: TeamJob[] }
const chat = (requestId: string, text: string) => ({ requestId, mode: 'chat', text })
const workflow = (requestId: string, text: string) => ({ requestId, mode: 'workflow', workflowId: 'delivery', text })
const vibe = (requestId: string, text: string) => ({ requestId, mode: 'vibe', nodeId: 'dev-local', text })
const last = (data: Snapshot) => data.messages.at(-1)

async function request(server: RunningServer, space: string, user: string, input?: Record<string, unknown>) {
  const path = `/api${space ? `/s/${space}` : ''}/space/team${input ? '/messages' : ''}`
  const res = await fetch(server.url + path, {
    method: input ? 'POST' : 'GET', headers: { 'x-takt-user': user, 'content-type': 'application/json' },
    body: input ? JSON.stringify(input) : undefined,
  })
  return { status: res.status, data: await res.json() as Snapshot }
}

async function fixture(options: Partial<ServerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-team-room-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const config = async (space: string, extra: Record<string, unknown> = {}) => {
    const path = join(root, space, 'takt.config.json')
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), ...extra }))
  }
  const members = [
    { id: 'alice', name: 'Alice', role: 'owner' }, { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'reader', name: 'Reader', role: 'viewer' },
  ]
  const alpha = await initSpace(join(root, 'alpha'), 'blank')
  const beta = await initSpace(join(root, 'beta'), 'blank')
  await Promise.all([config('alpha', { members }), config('beta', { members })])
  const start = async () => {
    const server = await createServer({ ...options, spacesDir: root, port: 0 })
    cleanups.push(() => server.close())
    return server
  }
  return { alpha, beta, config, start, server: await start() }
}

it('空间成员共享会话，记录实际发言人，跨重启保留且与其他空间隔离', async () => {
  const { server, start } = await fixture()
  const first = chat('same-id', '绝不跨空间的验收约定')
  expect((await request(server, 'alpha', 'alice', first)).status).toBe(200)
  const second = await request(server, 'alpha', 'bob', chat('same-id', '按刚刚约定继续'))
  expect(second.status).toBe(200)
  expect(second.data.messages.map(({ role, author }) => [role, author])).toEqual([
    ['human', 'alice'], ['steward', 'steward'], ['human', 'bob'], ['steward', 'steward'],
  ])
  expect(last(second.data)?.text).toContain('绝不跨空间的验收约定')
  expect(last(second.data)?.text).toContain('对话模型未配置或不可用')
  expect((await request(server, '', 'reader')).data).toEqual(second.data)
  expect((await request(server, 'beta', 'bob')).data).toEqual({ messages: [], nodes: [], jobs: [] })
  const beta = await request(server, 'beta', 'alice', chat('same-id', '乙空间单独发言'))
  expect(beta.data.messages).toHaveLength(2)
  expect(last(beta.data)?.text).not.toContain('绝不跨空间的验收约定')
  await server.close()
  const restarted = await start()
  expect((await request(restarted, 'alpha', 'alice', first)).data).toEqual(second.data)
})

it('只读成员可读但不可写，非成员不可读或写，无效输入不占用 requestId', async () => {
  const { server } = await fixture()
  const input = chat('validation', '一条消息')
  expect((await request(server, 'alpha', 'reader')).status).toBe(200)
  expect((await request(server, 'alpha', 'reader', input)).status).toBe(403)
  expect((await request(server, 'alpha', 'stranger')).status).toBe(403)
  expect((await request(server, 'alpha', 'stranger', input)).status).toBe(403)
  for (const invalid of [{ ...input, mode: 'oops' }, { ...input, text: ' ' }, { ...input, mode: 'workflow' }, { ...input, mode: 'vibe' }]) {
    expect((await request(server, 'alpha', 'bob', invalid)).status).toBe(400)
  }
  expect((await request(server, 'alpha', 'reader')).data.messages).toEqual([])
  expect((await request(server, 'alpha', 'bob', input)).status).toBe(200)
  expect((await request(server, 'alpha', 'bob', { ...input, text: '不是原消息' })).status).toBe(409)
})

it('并发重试仅创建一个真实需求并启动一次运行，保留正文与操作者', async () => {
  let release: () => void = () => {}
  const hold = new Promise<void>(resolve => { release = resolve })
  const startRun = vi.fn<NonNullable<CommandHandlers['startRun']>>()
  const { server, alpha } = await fixture({ getCommands: stores => createCommandRegistry({ stores, audit: async () => {}, startRun }) })
  startRun.mockImplementation(async ({ requirementId, workflowId }) => {
    await hold
    const stores = await openProject(alpha.projectDir)
    const runId = 'run-from-team'
    await stores.runs.create({ runId, workflowId, workflowVersion: '1', requirementId, status: 'running',
      startedAt: new Date().toISOString(), nodes: {}, expansions: [], args: {} }, { id: workflowId, version: '1', title: '交付', stages: [], nodes: [] })
    return { runId }
  })
  const draft = `清理购物车${'验收'.repeat(50)}\n原样保留第二行和换行。`
  const input = workflow('concurrent', draft)
  const pending = [request(server, 'alpha', 'bob', input), request(server, 'alpha', 'bob', input)]
  try {
    await expect.poll(() => startRun.mock.calls.length).toBe(1)
    expect((await request(server, 'alpha', 'reader')).data.messages).toHaveLength(1)
    expect((await request(server, 'alpha', 'alice', chat('independent', '先记下一条团队信息'))).status).toBe(200)
  } finally { release() }
  const [first, retry] = await Promise.all(pending)
  expect(first!.status).toBe(200)
  expect(retry).toEqual(first)
  expect(startRun).toHaveBeenCalledTimes(1)
  const reply = last(first!.data)!
  expect(reply).toMatchObject({ role: 'steward', runId: 'run-from-team' })
  expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ requirementId: reply.requirementId, workflowId: 'delivery' }),
    expect.objectContaining({ actor: { type: 'human', id: 'bob' } }))
  const stores = await openProject(alpha.projectDir)
  const requirements = await stores.workspaces.listRequirements()
  expect(requirements).toHaveLength(1)
  expect(requirements[0]).toMatchObject({ id: reply.requirementId, description: draft })
  expect(requirements[0]!.title).toHaveLength(60)
  expect((await stores.workspaces.readArtifact({ workspace: reply.requirementId!, path: 'inputs/prd.md' }))?.toString()).toBe(draft)
})

it('启动失败保留需求 ID 和 startError，重试不再创建需求或运行', async () => {
  const startRun = vi.fn(async () => { throw new Error('引擎尚未就绪') })
  const { server, alpha } = await fixture({ getCommands: stores => createCommandRegistry({ stores, audit: async () => {}, startRun }) })
  const input = workflow('partial', '保留需求\n以后启动')
  const first = await request(server, 'alpha', 'bob', input)
  expect(first.status).toBe(200)
  expect(last(first.data)).toMatchObject({ requirementId: expect.any(String), startError: '引擎尚未就绪' })
  expect(last(first.data)?.runId).toBeUndefined()
  expect(await request(server, 'alpha', 'bob', input)).toEqual(first)
  expect(startRun).toHaveBeenCalledTimes(1)
  expect(await (await openProject(alpha.projectDir)).workspaces.listRequirements()).toHaveLength(1)
})

it('节点任务的后续提交使用团队历史和关联结果，未关联的作业不进入提示词', async () => {
  const { server } = await fixture()
  const node = { id: 'dev-local', harness: 'local-harness', online: true }
  const jobs: TeamJob[] = [{ id: 'unlinked', nodeId: node.id, harness: node.harness, status: 'succeeded', result: '不应进入提示词' }]
  hub.teamNodes.mockImplementation(async stores => spaceId(stores) === 'alpha' ? [{ ...node, hidden: '内部字段' }] : [])
  hub.teamJobs.mockImplementation(async stores => spaceId(stores) === 'alpha' ? jobs : [])
  hub.enqueueTeamJob.mockImplementation(async (_stores, task) => {
    jobs.push({ id: task.id, nodeId: task.nodeId, harness: task.harness, status: 'succeeded', result: '安装失败；请补清单', prompt: task.prompt } as TeamJob)
    return { id: task.id }
  })
  await request(server, 'alpha', 'alice', chat('discussion', '团队决定先做安装检查'))
  const first = await request(server, 'alpha', 'bob', vibe('job-1', '检查安装'))
  const jobId = last(first.data)?.jobId
  expect(first.status).toBe(200)
  expect(jobId).toEqual(expect.any(String))
  expect(first.data.nodes).toEqual([node])
  expect(first.data.jobs.find(job => job.id === jobId)).not.toHaveProperty('prompt')
  const next = vibe('job-2', '按刚刚结果继续')
  expect((await request(server, 'alpha', 'alice', next)).status).toBe(200)
  expect((await request(server, 'alpha', 'alice', next)).status).toBe(200)
  expect(hub.enqueueTeamJob).toHaveBeenCalledTimes(2)
  const [, task] = hub.enqueueTeamJob.mock.calls[1]!
  expect(task).toMatchObject({ actorId: 'alice', nodeId: node.id, harness: node.harness })
  for (const part of ['团队决定先做安装检查', '按刚刚结果继续', '安装失败；请补清单', jobId]) expect(task.prompt).toContain(part)
  expect(task.prompt).not.toContain('不应进入提示词')
  expect((await request(server, 'beta', 'reader')).data.jobs).toEqual([])
})

it('派发报错后按持久化作业对账；确实未保存时不声称成功', async () => {
  const { server } = await fixture()
  const jobs: TeamJob[] = []
  hub.teamNodes.mockResolvedValue([{ id: 'dev-local', harness: 'local-harness', online: true }])
  hub.teamJobs.mockImplementation(async () => jobs)
  hub.enqueueTeamJob.mockImplementationOnce(async (_stores, { id, nodeId, harness }) => {
    jobs.push({ id, nodeId, harness, status: 'queued' })
    throw new Error('队列已保存，但应答中断')
  }).mockRejectedValueOnce(new Error('队列不可写'))
  const input = vibe('committed', '入队后中断')
  const queued = await request(server, 'alpha', 'bob', input)
  expect(queued.status).toBe(200)
  expect(last(queued.data)).toMatchObject({ jobId: jobs[0]!.id, text: expect.stringContaining('不会重复派发') })
  expect(await request(server, 'alpha', 'bob', input)).toEqual(queued)
  const missing = await request(server, 'alpha', 'bob', vibe('not-committed', '没有入队'))
  expect(last(missing.data)?.jobId).toBeUndefined()
  expect(last(missing.data)?.text).toContain('未能确认作业已入队')
  expect(hub.enqueueTeamJob).toHaveBeenCalledTimes(2)
})

it('中断后的重放补记回执，不重新执行已入队的作业', async () => {
  const { server, alpha } = await fixture()
  hub.teamNodes.mockResolvedValue([{ id: 'dev-local', harness: 'local-harness', online: true }])
  const jobs: TeamJob[] = []
  hub.teamJobs.mockImplementation(async () => jobs)
  hub.enqueueTeamJob.mockImplementation(async (_stores, { id, nodeId, harness }) => {
    jobs.push({ id, nodeId, harness, status: 'queued' })
    return { id }
  })
  const input = vibe('interrupted', '做一次')
  expect((await request(server, 'alpha', 'bob', input)).status).toBe(200)
  const file = join(alpha.taktDir, 'chat', '.team-room.json')
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as { messages: TeamMessage[]; receipts: Record<string, { finished?: true }> }
  onDisk.messages.pop()
  delete Object.values(onDisk.receipts)[0]!.finished
  await writeFile(file, JSON.stringify(onDisk))
  const retry = await request(server, 'alpha', 'bob', input)
  expect(retry.data.messages).toHaveLength(2)
  expect(last(retry.data)?.jobId).toBe(jobs[0]!.id)
  expect(hub.enqueueTeamJob).toHaveBeenCalledTimes(1)
})

it('按空间配置调用无工具模型回答追问；模型失败降级且不执行任何任务', async () => {
  const calls: Array<{ model: string; messages: Array<{ role: string; content: string }>; tools?: unknown }> = []
  const provider = createHttpServer((req, res) => {
    let body = ''
    req.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
      const call = JSON.parse(body) as typeof calls[number]
      calls.push(call)
      const prior = call.messages.find(message => message.role === 'user')?.content ?? ''
      const content = prior.includes('预发布先验收付款') ? '付款是预发布验收的第一项。' : '请给出验收主题。'
      const finish_reason = prior.includes('触发模型错误') ? 'content_filter' : 'stop'
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ finish_reason, message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections() }))
  const { server, alpha, config } = await fixture()
  const address = provider.address() as { port: number }
  await config('alpha', { steward: { harness: { harness: 'native', model: 'team-chat' } },
    providers: { local: { protocol: 'openai-chat', baseURL: `http://127.0.0.1:${address.port}/v1` } },
    models: { 'team-chat': { id: 'configured-chat-model', provider: 'local' } } })
  await request(server, 'beta', 'bob', chat('other-space', '不可泄漏的乙空间内容'))
  await request(server, 'alpha', 'alice', chat('topic', '预发布先验收付款'))
  const answer = await request(server, 'alpha', 'bob', chat('followup', '那我们先做什么？'))
  expect(last(answer.data)?.text).toBe('付款是预发布验收的第一项。')
  expect(calls.map(call => call.model)).toEqual(['configured-chat-model', 'configured-chat-model'])
  expect(calls[1]!.tools).toBeUndefined()
  const content = calls[1]!.messages.find(msg => msg.role === 'user')!.content
  expect(content).toContain('预发布先验收付款')
  expect(content).toContain('alice')
  expect(content).not.toContain('不可泄漏的乙空间内容')
  const fallback = await request(server, 'alpha', 'alice', chat('fallback', '触发模型错误'))
  expect(last(fallback.data)?.text).toContain('对话模型暂不可用')
  expect(last(fallback.data)?.text).toContain('那我们先做什么？')
  expect(hub.enqueueTeamJob).not.toHaveBeenCalled()
  expect(await (await openProject(alpha.projectDir)).workspaces.listRequirements()).toEqual([])
})
