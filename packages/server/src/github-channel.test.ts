import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject } from '@taktflow/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type RunningServer } from './index.js'
import { pollTeamJob, teamJobs } from './team-hub.js'
import { teamRoomStore } from './team-room-store.js'

const binding = { repo: 'team/shop', repoId: 10, spaceId: 'shop', privateReplies: true, members: { 45: 'alice', 46: 'reader' } }
const who = { id: 45, login: 'alice-before-rename', type: 'User' }
const base = '/repos/team/shop'
let root: string
let server: RunningServer
let stores: Awaited<ReturnType<typeof initProject>>
let outgoing: string[]
let commentCount: number
let privateRepo: boolean
let ambiguous: boolean
let originals: Map<number, ReturnType<typeof payload>>
function payload(id: number, body = '@takt-bot 设计一下首页') {
  return { action: 'created', repository: { id: 10, full_name: 'Team/Shop' }, sender: { ...who }, issue: { id: 1002, number: 2, state: 'open' },
    comment: { id, user: { ...who }, body, created_at: new Date().toISOString(), issue_url: 'https://api.github.com/repos/Team/Shop/issues/2' } }
}
const fetcher: typeof fetch = async (url, init) => {
  const request = new URL(String(url))
  expect(request.origin).toBe('https://api.github.com')
  if (request.pathname === '/user') return Response.json({ id: 90 })
  if (request.pathname === base) return Response.json({ id: 10, private: privateRepo, visibility: privateRepo ? 'private' : 'public' })
  if (request.pathname === base + '/issues/2') return Response.json({ id: 1002, state: 'open' })
  if (request.pathname.startsWith(base + '/issues/comments/')) return Response.json(originals.get(Number(request.pathname.split('/').at(-1)))?.comment ?? {})
  if (request.pathname !== base + '/issues/2/comments') throw new Error('回帖路径错误')
  if (init?.method !== 'POST') return Response.json(outgoing.map(body => ({ user: { id: 90 }, body })))
  const posted = JSON.parse(String(init.body)).body
  outgoing.push(posted)
  if (ambiguous) { ambiguous = false; return Response.json({}, { status: 503 }) }
  return Response.json({ id: ++commentCount })
}

function start() { return createServer({ projectDir: root, port: 0, githubFetch: fetcher }) }
async function deliver(event: ReturnType<typeof payload>, overrides: Record<string, string> = {}) {
  originals.set(event.comment.id, event)
  const body = JSON.stringify(event)
  return fetch(server.url + '/api/github/events', { method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-github-event': 'issue_comment', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'fixture').update(body).digest('hex'), ...overrides } })
}

beforeEach(async () => {
  vi.stubEnv('TAKT_GITHUB_BINDINGS', JSON.stringify([binding]))
  vi.stubEnv('TAKT_GITHUB_WEBHOOK_SECRET', 'fixture')
  vi.stubEnv('TAKT_GITHUB_TOKEN', 'fixture')
  vi.stubEnv('TAKT_GITHUB_BOT_ID', '90')
  vi.stubEnv('TAKT_GITHUB_BOT_LOGIN', 'takt-bot')
  root = await mkdtemp(join(tmpdir(), 'takt-github-'))
  stores = await initProject(root)
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, project: { ...stores.config.project, name: '内部项目甲' },
    space: { id: 'shop' }, members: [{ id: 'alice', name: 'Alice', role: 'member' }, { id: 'reader', name: 'Reader', role: 'viewer' }] }))
  outgoing = []; originals = new Map(); privateRepo = true; ambiguous = false; commentCount = 0
  server = await start()
})
afterEach(async () => { await server.close(); vi.unstubAllEnvs(); await rm(root, { force: true, recursive: true }) })

it('验签后写入空间共享管家并回到同一个私有 issue；投递重复和不确定的回复跨重启去重', async () => {
  const event = payload(50)
  ambiguous = true
  const responses = await Promise.all([deliver(event), deliver(event)])
  expect(responses.map(response => response.status)).toEqual([202, 202])
  await vi.waitFor(() => expect(outgoing).toHaveLength(1))
  await server.close()
  server = await start()
  await deliver(event)
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(outgoing).toHaveLength(1)
  expect(outgoing[0]).toContain('内部项目甲')
  const messages = await teamRoomStore(stores.taktDir).messages()
  expect(messages).toMatchObject([{ source: 'github', author: 'alice', role: 'human', text: '设计一下首页' }, { source: 'github', role: 'steward' }])
})

it('公开 issue 获取收件回执；无签名、PR、机器人、自回声、访客和其他仓库均无法发言', async () => {
  privateRepo = false
  const event = payload(51)
  expect((await deliver(event, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status).toBe(401)
  expect((await deliver({ ...event, repository: { ...event.repository, id: 11 } })).status).toBe(202)
  for (const user of [{ ...who, id: 46 }, { ...who, id: 90 }, { ...who, type: 'Bot' }, { ...who, id: 99 }]) {
    await deliver({ ...event, sender: user, comment: { ...event.comment, user } })
  }
  await deliver({ ...event, issue: { ...event.issue, pull_request: {} } } as typeof event)
  await deliver(payload(52, '其他评论 @takt-bot hello'))
  await deliver(payload(53, '@takt-bot /vibe ../evil 内容'))
  await deliver({ ...event, comment: { ...event.comment, created_at: '2000-01-01T00:00:00Z' } })
  expect(await teamRoomStore(stores.taktDir).messages()).toEqual([])
  expect(outgoing).toHaveLength(0)
  await deliver(event)
  await vi.waitFor(() => expect(outgoing).toHaveLength(1))
  expect(outgoing[0]).toMatch(/^空间管家已处理/)
  expect(outgoing[0]).not.toContain('内部项目甲')
  expect(outgoing[0]).not.toContain('设计一下首页')
})

it('GitHub 映射不能保留已移除的空间成员权限', async () => {
  const path = join(root, 'takt.config.json')
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), members: [] }))
  await deliver(payload(52))
  expect(await teamRoomStore(stores.taktDir).messages()).toEqual([])
  expect(outgoing).toHaveLength(0)
})

it('显式开发命令进入共享执行流程，重复投递只会创建一个作业或需求', async () => {
  await pollTeamJob(stores, { id: 'mac-dev', session: 'test', harness: 'codex' }, 1)
  const vibe = payload(60, '@takt-bot /vibe mac-dev 为导出按钮添加进度')
  await Promise.all([deliver(vibe), deliver(vibe)])
  await vi.waitFor(() => expect(outgoing).toHaveLength(1))
  expect(await teamJobs(stores)).toMatchObject([{ nodeId: 'mac-dev', status: 'queued' }])
  const workflow = payload(61, '@takt-bot /workflow delivery 为订单添加导出')
  await deliver(workflow)
  await deliver(workflow)
  await vi.waitFor(() => expect(outgoing).toHaveLength(2))
  expect(await stores.workspaces.listRequirements()).toMatchObject([{ title: '为订单添加导出', owner: 'alice' }])
})
