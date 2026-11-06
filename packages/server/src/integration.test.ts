import { acquireLease, releaseLease, readLease, withSpaceLease, type RoomMessage } from '@taktflow/core'
import { createApiCore, type WriteOp } from './api-core.js'
import { auditSpace, workflowStore } from './space.js'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createEngine, FsEventStore, initProject, type RunState, type WorkflowDocument } from '@taktflow/core'
import { createServer, type RunningServer } from './index.js'

const roots: string[] = []
const servers: RunningServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-server-m2b-')); roots.push(root)
  const stores = await initProject(root)
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(stores.paths.workflows, 'test.workflow.ts'), `import { defineWorkflow, script } from '@taktflow/core'\nexport default defineWorkflow({ id: 'test', title: '初始', version: '1', stages: [], nodes: [script({ id: 'work', title: '工作', run: async () => {} })] })\n`)
  const req = await stores.workspaces.createRequirement({ title: '测试群聊', owner: 'alice' })
  return { root, stores, req }
}
async function start(options: Parameters<typeof createServer>[0]) { const server = await createServer({ ...options, port: 0 }); servers.push(server); return server }
async function request(server: RunningServer, path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(server.url + path, { method, body: value === undefined ? undefined : JSON.stringify(value), headers: { 'content-type': 'application/json', ...headers } })
  return { status: res.status, data: await res.json() }
}
async function chunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([reader.read().then(({ value }) => new TextDecoder().decode(value)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE 超时')), 6000) })]) }
  finally { clearTimeout(timer) }
}

it('仓库 PATCH 的 null 删除可选字段，省略字段保留，必填字段仍校验', async () => {
  const { root } = await fixture()
  const server = await start({ projectDir: root })
  const binding = { id: 'app', path: 'app', defaultBranch: 'main', url: 'https://example.com/app.git', purpose: 'app', description: '应用', bootstrap: 'npm test', share: ['node_modules'], reason: '绑定' }
  expect((await request(server, '/api/space/repos', 'POST', binding)).status).toBe(200)
  const patch = '/api/space/repos/app'
  expect((await request(server, patch, 'PATCH', { bootstrap: null, reason: '清空引导' })).status).toBe(200)
  let saved = JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8')).repos[0]
  expect(saved).not.toHaveProperty('bootstrap')
  expect(saved).toMatchObject({ url: binding.url, purpose: 'app', description: '应用', share: ['node_modules'] })
  expect((await request(server, patch, 'PATCH', { url: null, purpose: null, description: null, share: null, reason: '清空可选字段' })).status).toBe(200)
  saved = JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8')).repos[0]
  expect(saved).toEqual({ id: 'app', path: 'app', defaultBranch: 'main' })
  expect((await request(server, '/api/space')).data.repos[0]).toMatchObject(saved)
  expect((await request(server, patch, 'PATCH', { path: null, reason: '必填字段' })).status).toBe(400)
  expect((await request(server, patch, 'PATCH', { bootstrap: '', reason: '空字符串' })).status).toBe(400)
  expect(JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8')).repos[0]).toEqual(saved)
})

it('空间资产读写、成员、仓库同步必须带原因，并复用 EventStore 验证空间哈希链', async () => {
  const { root, stores } = await fixture()
  const server = await start({ projectDir: root })
  expect((await request(server, '/api/spaces')).data).toHaveLength(1)
  expect((await request(server, '/api/space')).data.workflows[0].id).toBe('test')
  expect((await request(server, '/api/space/members', 'PUT', { members: [] })).status).toBe(400)
  expect((await request(server, '/api/space/members', 'PUT', [{ id: 'bob', name: 'Bob', role: 'maintainer' }, { id: 'alice', name: 'Alice', role: 'owner' }], { 'x-takt-reason': 'team update', 'x-takt-user': 'alice' })).data.members[0].id).toBe('bob')
  expect((await request(server, '/api/space/members', 'PUT', { members: [{ id: 'a', name: 'A', role: 'root' }], reason: '错误成员' })).status).toBe(400)
  for (const kind of ['skill', 'agent']) {
    const path = `/api/space/files?kind=${kind}&name=demo`
    expect((await request(server, path)).status).toBe(404)
    expect((await request(server, path, 'PUT', { content: 'body' })).status).toBe(400)
    const content = kind === 'skill' ? '---\nname: demo\ndescription: 示例\n---\n技能' : '---\nharness: mock\n---\n角色'
    expect((await request(server, path, 'PUT', { content, reason: '增加资产' }, { 'x-takt-user': 'alice' })).data.content).toBe(content)
    expect((await request(server, path)).data.content).toBe(content)
  }
  expect((await request(server, '/api/space')).data.skills[0].name).toBe('demo')
  expect((await request(server, '/api/space')).data.agents[0].role).toBe('demo')
  expect((await request(server, '/api/space/files?kind=agent&name=../escape')).status).toBe(400)
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, join(stores.paths.skills, 'linked'), 'dir')
  expect((await request(server, '/api/space/files?kind=skill&name=linked', 'PUT', { content: 'escape', reason: '测试' })).status).toBe(400)
  const repo = join(root, 'app'); await mkdir(repo)
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'base']]) execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  const input = { id: 'app', path: 'app', defaultBranch: 'main', reason: '绑定代码库' }
  expect((await request(server, '/api/space/repos', 'POST', input)).data.repos[0].status).toBe('ready')
  expect((await request(server, '/api/space/repos', 'POST', input)).status).toBe(409)
  expect((await request(server, '/api/space/repos/app/sync', 'POST', {})).status).toBe(400)
  expect((await request(server, '/api/space/repos/app/sync', 'POST', { reason: '同步' })).data.head).toMatch(/^[a-f0-9]{40}$/)
  expect((await request(server, '/api/space/repos/missing/sync', 'POST', { reason: '同步' })).status).toBe(404)
  const scratch = join(root, 'audit-copy/runs/space'); await mkdir(scratch, { recursive: true })
  await copyFile(join(stores.taktDir, 'space-events.jsonl'), join(scratch, 'events.jsonl'))
  const events = new FsEventStore(join(root, 'audit-copy'))
  expect(await events.verify('space')).toEqual({ ok: true })
  const log = await events.read('space')
  expect(log).toHaveLength(5)
  expect(log[0]!.actor).toEqual({ type: 'human', id: 'alice' })
  expect(JSON.parse((log[0]!.data as { message: string }).message).reason).toBe('team update')
})

it('workflow 的全部读写、冲突、布局、修订、回滚与 SSE 路由保留作者', async () => {
  const { root } = await fixture(); const server = await start({ projectDir: root })
  const first = (await request(server, '/api/workflows/test')).data as WorkflowDocument
  expect(first.diagnostics).toEqual([])
  const abort = new AbortController()
  const stream = await fetch(server.url + '/api/workflows/test/stream', { signal: abort.signal })
  const reader = stream.body!.getReader()
  const pending = chunk(reader)
  const second = await request(server, '/api/workflows/test', 'PATCH', { baseRev: first.rev, edits: [{ op: 'setMeta', key: 'title', value: '改名' }], reason: '调整标题' }, { 'x-takt-user': 'editor' })
  expect(second.status).toBe(200)
  expect(JSON.parse((await pending).split('data: ')[1]!.trim()).revision.author).toEqual({ type: 'human', id: 'editor' })
  abort.abort()
  const conflict = await request(server, '/api/workflows/test', 'PATCH', { baseRev: first.rev, edits: [{ op: 'setMeta', key: 'title', value: '并发标题' }] })
  expect(conflict.status).toBe(409); expect(conflict.data.error).toBe('conflict')
  expect((await request(server, '/api/workflows/test/layout', 'PUT', { nodes: { work: { x: 12, y: 34 } }, viewport: { x: 1, y: 2, zoom: 1 } })).status).toBe(200)
  expect((await request(server, '/api/workflows/test')).data.layout.nodes.work.x).toBe(12)
  expect((await request(server, '/api/workflows/test/layout', 'PUT', { nodes: { work: { x: 'bad', y: 2 } } })).status).toBe(400)
  const source = second.data.source.replace("title: '工作'", "title: '新工作'")
  const replaced = await request(server, '/api/workflows/test/source', 'PUT', { baseRev: second.data.rev, source, reason: '改源码' })
  expect(replaced.status).toBe(200)
  const revisions = (await request(server, '/api/workflows/test/revisions')).data
  expect(revisions).toHaveLength(3)
  expect(revisions.at(-1).author.id).toBe('web')
  const revision = (await request(server, `/api/workflows/test/revisions/${replaced.data.rev}`)).data
  expect(revision.diff).toContain('新工作')
  expect((await request(server, '/api/workflows/test/rollback', 'POST', { rev: first.rev, reason: '恢复初始' })).data.source).toBe(first.source)
  expect((await request(server, '/api/workflows/test', 'PATCH', { baseRev: first.rev, edits: [{ op: 'setNeeds', id: 'work', needs: ['missing'] }] })).status).toBe(400)
  expect((await request(server, '/api/workflows/missing')).status).toBe(404)
}, 20000)

it('群聊成员、消息回放和实时 SSE，@lead 只调用注入点且失败可回读', async () => {
  const { root, stores, req } = await fixture()
  const mentions: string[] = []
  const server = await start({ projectDir: root, onLeadMention: async (id, message) => { mentions.push(`${id}:${message.text}`); if (message.text.includes('fail')) throw new Error('回调失败') } })
  const base = `/api/requirements/${req.id}`
  expect((await request(server, base + '/room')).data.members.some((member: { id: string }) => member.id === 'lead')).toBe(true)
  expect((await request(server, base + '/room/members', 'POST', [{ id: 'bob', kind: 'human', name: 'Bob' }])).data.members.some((member: { id: string }) => member.id === 'bob')).toBe(true)
  const msg = await request(server, base + '/chat', 'POST', { text: '@lead 状态如何' }, { 'x-takt-user': 'alice' })
  expect(msg.data.mentions).toEqual(['lead'])
  const abort = new AbortController()
  const res = await fetch(server.url + base + '/chat/stream', { signal: abort.signal, headers: { 'last-event-id': String(msg.data.seq - 1) } })
  const reader = res.body!.getReader(); expect(await chunk(reader)).toContain(msg.data.id)
  const live = chunk(reader)
  const next = await request(server, base + '/chat', 'POST', { text: '收到', replyTo: msg.data.id })
  expect(await live).toContain(next.data.id)
  abort.abort()
  expect((await request(server, base + `/chat?after=${msg.data.seq}&limit=1`)).data[0].id).toBe(next.data.id)
  await request(server, base + '/chat', 'POST', { text: 'fail', mentions: ['lead'] })
  for (let i = 0; i < 30 && !(await stores.chat.list(req.id)).some((message) => message.text.includes('Lead 回调失败')); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(mentions).toEqual([`${req.id}:@lead 状态如何`, `${req.id}:fail`])
  expect((await stores.chat.list(req.id)).at(-1)?.text).toContain('Lead 回调失败')
  expect((await request(server, base + '/chat', 'POST', { text: ' ', mentions: [] })).status).toBe(400)
  expect((await request(server, base + '/chat?after=bad')).status).toBe(400)
  expect((await request(server, '/api/requirements/missing/chat')).status).toBe(404)
})

it('评审列表和 NodeDetail.review 返回实际轮次；临时任务摘要从群消息找来源', async () => {
  const { root, stores, req } = await fixture()
  const state = await createEngine({ stores, profiles: { author: { role: 'author', title: '作者', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } }, reviewer: { role: 'reviewer', title: '评审', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } } },
    knowledge: [], harnesses: { mock: { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), capabilities: { structuredOutput: true }, run: async () => ({ ok: true, finalText: '', structured: { verdict: 'approve', summary: '通过', issues: [] } }) } } }, { autoApprove: true }).start({ requirementId: req.id,
    workflow: { id: 'task:reviewer', title: '临时评审', version: '1', stages: [], nodes: [
      { id: 'write', kind: 'script', title: '产出', outputs: [{ path: 'spec.md', kind: 'spec' }], run: async (ctx) => { await writeFile(join(ctx.workspaceDir, 'spec.md'), 'AC-1') } },
      { id: 'review', kind: 'review', title: '评审', needs: ['write'], target: ['spec.md'], author: { role: 'author' }, reviewers: [{ role: 'reviewer' }], maxRounds: 1, onExhausted: 'fail' },
    ] } })
  const trigger = await stores.chat.post(req.id, { author: { type: 'human', id: 'alice' }, kind: 'text', text: '请评审' })
  await stores.chat.post(req.id, { author: { type: 'agent', role: 'lead', harness: 'mock' }, kind: 'task', text: '临时评审', replyTo: trigger.id, refs: { taskRunId: state.runId } })
  const server = await start({ projectDir: root })
  const reviews = (await request(server, `/api/requirements/${req.id}/reviews`)).data
  expect(reviews[0]).toMatchObject({ status: 'passed', round: 1 })
  const node = (await request(server, `/api/runs/${state.runId}/nodes/review`)).data
  expect(node.review.rounds[0].records[0].verdict).toBe('approve')
  const summary = (await request(server, '/api/runs')).data[0]
  expect(summary.kind).toBe('task'); expect(summary.origin).toMatchObject({ kind: 'chat', messageId: trigger.id, by: trigger.author })
})

it('多空间前缀隔离数据、回调与默认空间，并拒绝重复空间 ID', async () => {
  const a = await fixture(); const b = await fixture()
  const parent = await mkdtemp(join(tmpdir(), 'takt-spaces-')); roots.push(parent)
  const { cp } = await import('node:fs/promises')
  for (const [name, fixture] of [['hello-delivery', a], ['standard-delivery', b]] as const) await cp(fixture.root, join(parent, name), { recursive: true, filter: (file) => !file.endsWith('node_modules') })
  const calls: string[] = []
  const server = await start({ spacesDir: parent, onSpaceLeadMention: (dir) => { calls.push(dir) } })
  expect((await request(server, '/api/spaces')).data.map((space: { id: string }) => space.id)).toEqual(['hello-delivery', 'standard-delivery'])
  const msg = await request(server, `/api/s/standard-delivery/requirements/${b.req.id}/chat`, 'POST', { text: '@lead hi' })
  expect(msg.status).toBe(200)
  expect((await request(server, `/api/requirements/${a.req.id}/chat`)).data.some((message: { text: string }) => message.text === '@lead hi')).toBe(false)
  expect((await request(server, `/api/s/standard-delivery/requirements/${b.req.id}/chat`)).data.at(-1).id).toBe(msg.data.id)
  expect(calls).toEqual([join(parent, 'standard-delivery')])
  expect((await request(server, '/api/s/missing/space')).status).toBe(404)
  for (const name of ['hello-delivery', 'standard-delivery']) {
    const file = join(parent, name, 'takt.config.json')
    const config = JSON.parse(await readFile(file, 'utf8')); config.space = { id: 'duplicate' }; await writeFile(file, JSON.stringify(config))
  }
  await expect(createServer({ spacesDir: parent, port: 0 })).rejects.toThrow('重复')
})


it('api-core 覆盖 M2 读写操作，宿主 Actor 字段与工作流修订可回读', async () => {
  const { stores, req } = await fixture()
  let leased = 0
  const core = createApiCore({ withWriteLease: async (_, fn) => { leased++; return fn() } })
  const author = { type: 'human' as const, id: 'alice', via: 'dsh-web' }
  expect(await core.read(stores, 'reviews', { id: req.id })).toEqual([])
  expect(await core.read(stores, 'room', { id: req.id })).toMatchObject({ id: req.id })
  await core.write(stores, 'space.members', {}, { members: [{ id: 'alice', name: 'Alice', role: 'owner' }], reason: '设置' }, author)
  expect(await core.read(stores, 'space', {})).toMatchObject({ members: [{ id: 'alice' }] })
  await core.write(stores, 'room.members', { id: req.id }, { members: [{ id: 'bob', name: 'Bob', kind: 'human' }] }, author)
  const message = await core.write(stores, 'chat.send', { id: req.id }, { text: '讨论' }, author) as RoomMessage
  expect(await core.read(stores, 'chat', { id: req.id, after: String(message.seq - 1), limit: '1' })).toMatchObject([{ id: message.id, author }])
  await core.write(stores, 'space.file.edit', { kind: 'skill', name: 'demo' }, { content: 'skill', reason: '示例' }, author)
  expect(await core.read(stores, 'space.file', { kind: 'skill', name: 'demo' })).toMatchObject({ content: 'skill' })
  const first = await core.read(stores, 'workflow.source', { id: 'test' }) as WorkflowDocument
  expect(await core.read(stores, 'workflows', {})).toMatchObject([{ id: 'test' }])
  const edited = await core.write(stores, 'workflow.edit', { id: 'test' }, { baseRev: first.rev, edits: [{ op: 'setMeta', key: 'title', value: '宿主修改' }] }, author) as WorkflowDocument
  expect(edited.source).toContain('宿主修改')
  expect(await core.read(stores, 'workflow.revisions', { id: 'test' })).toMatchObject([{}, { author }])
  expect(await core.read(stores, 'workflow.revision', { id: 'test', rev: edited.rev })).toMatchObject({ source: edited.source, revision: { author } })
  expect(leased).toBeGreaterThanOrEqual(5)
})

it('每个 M2 写操作在处理请求体前经过租约；多空间只拦截被占用的空间', async () => {
  const { root, stores, req } = await fixture()
  const ops: WriteOp[] = ['artifact.edit', 'comment.add', 'attention.answer', 'space.members', 'space.repo.add', 'space.repo.sync', 'space.file.edit', 'room.members', 'chat.send', 'workflow.edit', 'workflow.source.replace', 'workflow.layout', 'workflow.rollback']
  const hook = <T>(stores: import('@taktflow/core').ProjectStores, fn: () => Promise<T>) => withSpaceLease(stores.taktDir, 'serve:test', fn)
  const core = createApiCore({ withWriteLease: hook })
  await acquireLease(stores.taktDir, 'dsh:busy')
  try {
    for (const op of ops) await expect(core.write(stores, op, {}, () => { throw new Error('不应读取请求体') }, { type: 'human', id: 'alice' })).rejects.toMatchObject({ status: 409 })
    const server = await start({ projectDir: root, withWriteLease: hook })
    expect((await request(server, `/api/requirements/${req.id}/chat`, 'POST', { text: '拒绝' })).status).toBe(409)
    expect((await request(server, `/api/requirements/${req.id}/chat`)).status).toBe(200)
    expect((await stores.chat.list(req.id)).map((message) => message.text)).toEqual(['需求已创建'])
  } finally { await releaseLease(stores.taktDir, 'dsh:busy') }
  const parent = await mkdtemp(join(tmpdir(), 'takt-multi-lease-')); roots.push(parent)
  const a = await initProject(join(parent, 'a')); const b = await initProject(join(parent, 'b'))
  const ra = await a.workspaces.createRequirement({ title: 'A' }); const rb = await b.workspaces.createRequirement({ title: 'B' })
  const server = await start({ spacesDir: parent, withWriteLease: hook })
  await acquireLease(a.taktDir, 'dsh:a')
  try {
    expect((await request(server, `/api/s/a/requirements/${ra.id}/chat`, 'POST', { text: '拒绝' })).status).toBe(409)
    expect((await request(server, `/api/s/b/requirements/${rb.id}/chat`, 'POST', { text: '允许' })).status).toBe(200)
    expect((await b.chat.list(rb.id)).at(-1)?.text).toBe('允许')
  } finally { await releaseLease(a.taktDir, 'dsh:a') }
})

it('后台 Lead 回调在 HTTP 返回后仍持有租约，结束后释放', async () => {
  const { root, stores, req } = await fixture()
  let release!: () => void; let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { started = resolve })
  let complete!: () => void
  const completed = new Promise<void>((resolve) => { complete = resolve })
  const server = await start({ projectDir: root,
    withWriteLease: async (stores, fn) => { try { return await withSpaceLease(stores.taktDir, 'serve:callback', fn) } finally { if (!await readLease(stores.taktDir)) complete() } },
    onLeadMention: async () => { started(); await gate },
  })
  try {
    expect((await request(server, `/api/requirements/${req.id}/chat`, 'POST', { text: '@lead hi' })).status).toBe(200)
    await ready
    expect((await acquireLease(stores.taktDir, 'dsh:other')).ok).toBe(false)
  } finally { release(); await completed }
  await vi.waitFor(async () => expect(await readLease(stores.taktDir)).toBeUndefined())
})

it('空间审计保留链尾锚点，截尾后拒绝追加掩盖损坏', async () => {
  const { stores } = await fixture()
  const author = { type: 'human' as const, id: 'alice' }
  await auditSpace(stores, author, '测试', '一')
  await auditSpace(stores, author, '测试', '二')
  const file = join(stores.taktDir, 'space-events.jsonl')
  const text = await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8'))
  await writeFile(file, text.split('\n')[0] + '\n')
  await expect(auditSpace(stores, author, '测试', '三')).rejects.toThrow('空间审计链已损坏')
})


it('workflow 读取和 SSE 的外部修订登记也遵守租约，释放后恢复通知', async () => {
  const { stores } = await fixture()
  const core = createApiCore({ withWriteLease: (stores, fn) => withSpaceLease(stores.taktDir, 'serve:watch', fn) })
  await acquireLease(stores.taktDir, 'dsh:other')
  try {
    await expect(core.read(stores, 'workflow', { id: 'test' })).rejects.toMatchObject({ status: 409 })
    expect(await workflowStore(stores).revisions('test')).toEqual([])
  } finally { await releaseLease(stores.taktDir, 'dsh:other') }
  const document = await core.read(stores, 'workflow', { id: 'test' }) as WorkflowDocument
  let receive!: (event: import('@taktflow/core').WorkflowChangedEvent) => void
  const notification = new Promise<import('@taktflow/core').WorkflowChangedEvent>((resolve) => { receive = resolve })
  const errors: unknown[] = []
  const stop = core.subscribeWorkflow(stores, 'test', receive, (error) => errors.push(error))
  try {
    await acquireLease(stores.taktDir, 'dsh:other')
    try {
      await writeFile(join(stores.paths.workflows, 'test.workflow.ts'), document.source.replace('初始', '外部变更'))
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(await workflowStore(stores).revisions('test')).toHaveLength(1)
    } finally { await releaseLease(stores.taktDir, 'dsh:other') }
    expect((await notification).revision.author).toMatchObject({ type: 'agent', harness: 'external' })
    expect(errors).toEqual([])
  } finally { await stop() }
})
