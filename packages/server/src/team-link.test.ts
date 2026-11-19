import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject, openProject, sha256 } from '@taktflow/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type RunningServer } from './index.js'
import { LINK_TTL_MS } from './team-admissions.js'
import { enqueueTeamJob, teamJobs, teamNodes, TEAM_LEASE_MS } from './team-hub.js'
import { storagePath, teamFileLock } from './team-storage.js'

const ENV_TOKEN = 'e'.repeat(43)
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/
const dev = '/api/space/devices'
const jsonHeaders = { 'content-type': 'application/json' }
const linkInput = { nodeId: 'desktop', harness: 'codex' }
const jobInput = { nodeId: 'desktop', harness: 'codex', prompt: 'Update the README', actorId: 'owner' }
let root: string
let servers: RunningServer[]

beforeEach(async () => {
  vi.stubEnv('TAKT_TEAM_NODES', undefined)
  root = await mkdtemp(join(tmpdir(), 'takt-team-link-'))
  servers = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(servers.map(server => server.close()))
  await rm(root, { recursive: true, force: true })
})

async function project(id: string, dir = join(root, id)) {
  const stores = await initProject(dir)
  const members = [
    { id: 'owner', name: 'Owner', role: 'owner' },
    { id: 'reader', name: 'Reader', role: 'viewer' },
    { id: 'maintainer', name: 'Maintainer', role: 'maintainer' },
  ]
  await writeFile(join(dir, 'takt.config.json'), JSON.stringify({ ...stores.config, space: { id }, members }))
  return openProject(dir)
}

async function start(single = false) {
  const server = await createServer({ ...(single ? { projectDir: root } : { spacesDir: root }), port: 0 })
  servers.push(server)
  return server
}

function device(server: RunningServer, path = dev, method = 'GET', user: string | null = 'owner', input?: object) {
  return fetch(server.url + path, { method, headers: { ...jsonHeaders, ...(user !== null ? { 'x-takt-user': user } : {}) },
    body: input ? JSON.stringify(input) : undefined })
}

function worker(server: RunningServer, action: string, input: object, options: { space?: string; node?: string; token?: string; origin?: string } = {}) {
  return fetch(`${server.url}/api/team-worker/v1/${options.space ?? 'alpha'}/${options.node ?? 'desktop'}/${action}`, {
    method: 'POST', headers: { ...jsonHeaders, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { origin: options.origin } : {}) }, body: JSON.stringify({ harness: 'codex', session: 'instance-a', ...input }),
  })
}

async function issue(server: RunningServer, path = dev) {
  const response = await device(server, `${path}/link`, 'POST', 'owner', linkInput)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return await response.json() as { nodeId: string; harness: string; code: string; expiresAt: string }
}

async function enroll(server: RunningServer) {
  const { code } = await issue(server)
  const result = await worker(server, 'link', { code })
  expect(result.status).toBe(200)
  const { token } = await result.json() as { token: string }
  expect(DEVICE_TOKEN.test(token)).toBe(true)
  return token
}

it('只向显式空间成员提供只读库存，静态设备只从环境变量管理', async () => {
  vi.stubEnv('TAKT_TEAM_NODES', JSON.stringify([{ spaceId: 'alpha', nodeId: 'env-box', harness: 'codex', token: ENV_TOKEN }]))
  await project('alpha')
  await project('beta')
  const server = await start()
  for (const user of [null, 'web', 'outsider']) expect((await device(server, dev, 'GET', user)).status).toBe(403)
  for (const user of [null, 'web', 'outsider', 'reader', 'maintainer']) {
    expect((await device(server, `${dev}/link`, 'POST', user, linkInput)).status).toBe(403)
    expect((await device(server, `${dev}/desktop`, 'DELETE', user)).status).toBe(403)
  }
  expect(await (await device(server, dev, 'GET', 'reader')).json()).toEqual({ spaceId: 'alpha', devices: [
    { nodeId: 'env-box', harness: 'codex', source: 'env', status: 'offline' },
  ] })
  expect(await (await device(server, '/api/s/beta/space/devices')).json()).toEqual({ spaceId: 'beta', devices: [] })
  await expect(lstat(join(root, '.takt-team-link'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(root, 'alpha', '.takt', 'runs', '.team-hub'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await device(server, `${dev}/link`, 'POST', 'owner', { ...linkInput, nodeId: 'env-box' })).status).toBe(409)
  expect((await device(server, `${dev}/env-box`, 'DELETE')).status).toBe(409)
  expect((await device(server, `${dev}/link`, 'POST', 'owner', { ...linkInput, harness: 'other' })).status).toBe(400)
  expect((await device(server, `${dev}/link`, 'POST', 'owner', { ...linkInput, nodeId: '../desktop' })).status).toBe(400)
  expect((await device(server, `${dev}/a%2Fb`, 'DELETE')).status).toBe(400)
  expect((await worker(server, 'poll', { poll: 1 }, { node: 'env-box', token: ENV_TOKEN })).status).toBe(200)
  expect(await (await device(server)).json()).toMatchObject({ devices: [{ nodeId: 'env-box', source: 'env', status: 'online', lastSeenAt: expect.any(String) }] })
})

it('连接码按空间与节点隔离，并发只兑现一次，凭据重启后仍可用且仅存哈希', async () => {
  await project('alpha', join(root, 'first'))
  await project('Alpha', join(root, 'second'))
  let server = await start()
  const space = 'Alpha'
  const inventoryPath = `/api/s/${space}/space/devices`
  const invite = await issue(server, inventoryPath)
  expect(DEVICE_TOKEN.test(invite.code)).toBe(true)
  expect(invite.nodeId).toBe('desktop')
  expect(invite.harness).toBe('codex')
  expect(await (await device(server, '/api/s/alpha/space/devices')).json()).toEqual({ spaceId: 'alpha', devices: [] })
  expect(await (await device(server, inventoryPath)).json()).toEqual({ spaceId: space, devices: [
    { nodeId: 'desktop', harness: 'codex', source: 'link', status: 'pending', expiresAt: invite.expiresAt },
  ] })
  expect((await worker(server, 'poll', { poll: 1 }, { space, token: invite.code })).status).toBe(401)
  expect((await worker(server, 'link', { code: invite.code })).status).toBe(401)
  expect((await worker(server, 'link', { code: invite.code }, { space, node: 'other' })).status).toBe(401)
  expect((await worker(server, 'link', { code: invite.code, harness: 'bad' }, { space })).status).toBe(400)
  expect((await worker(server, 'link', { code: invite.code }, { space, origin: 'http://localhost:5173' })).status).toBe(403)

  const privateRoot = join(root, '.takt-team-link')
  const file = join(privateRoot, `${sha256(space)}.json`)
  const pending = await readFile(file, 'utf8')
  expect(pending.includes(invite.code)).toBe(false)
  expect(pending.includes(sha256(invite.code))).toBe(true)
  expect((await lstat(privateRoot)).mode & 0o777).toBe(0o700)
  expect((await lstat(file)).mode & 0o777).toBe(0o600)
  await server.close()
  server = await start()
  const second = await start()
  const replies = await Promise.all([server, second, server].map(hub => worker(hub, 'link', { code: invite.code }, { space })))
  expect(replies.map(reply => reply.status).sort()).toEqual([200, 401, 401])
  const success = replies.find(reply => reply.ok)!
  expect(success.headers.get('cache-control')).toBe('no-store')
  const result = await success.json() as { token: string }
  expect(Object.keys(result)).toEqual(['token'])
  expect(DEVICE_TOKEN.test(result.token)).toBe(true)
  const stored = await readFile(file, 'utf8')
  expect(stored.includes(result.token)).toBe(false)
  expect(stored.includes(sha256(result.token))).toBe(true)
  expect(stored.includes(sha256(invite.code))).toBe(false)
  expect(await (await device(server, inventoryPath)).json()).toEqual({ spaceId: space, devices: [
    { nodeId: 'desktop', harness: 'codex', source: 'link', status: 'offline' },
  ] })
  expect((await device(server, `${inventoryPath}/link`, 'POST', 'owner', linkInput)).status).toBe(409)
  await Promise.all([server.close(), second.close()])
  server = await start()
  expect(await (await worker(server, 'poll', { poll: 1 }, { space, token: result.token })).json()).toEqual({ job: null })
  expect((await worker(server, 'link', { code: invite.code }, { space })).status).toBe(401)
  const inventory = await (await device(server, inventoryPath)).text()
  for (const secret of [invite.code, result.token, sha256(result.token), sha256(invite.code)]) expect(inventory.includes(secret)).toBe(false)
})

it('连接码十分钟失效，替换和撤销 pending 都使旧码不可用', async () => {
  await project('alpha', root)
  const server = await start(true)
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const first = await issue(server)
  expect(Date.parse(first.expiresAt) - now).toBe(10 * 60_000)
  expect(await readdir(join(root, '.takt', 'runs', '.team-link'))).toHaveLength(1)
  const second = await issue(server)
  expect((await worker(server, 'link', { code: first.code })).status).toBe(401)
  now += LINK_TTL_MS
  expect((await worker(server, 'link', { code: second.code })).status).toBe(401)
  expect(await (await device(server)).json()).toEqual({ spaceId: 'alpha', devices: [] })
  const current = await issue(server)
  expect((await device(server, `${dev}/desktop`, 'DELETE')).status).toBe(200)
  expect((await worker(server, 'link', { code: current.code })).status).toBe(401)
  expect((await device(server, `${dev}/desktop`, 'DELETE')).status).toBe(404)
})

it('动态和静态设备并存，撤销同时移除排队和在途工作，复用 ID 不能接管旧任务', async () => {
  vi.stubEnv('TAKT_TEAM_NODES', JSON.stringify([{ spaceId: 'alpha', nodeId: 'env-box', harness: 'codex', token: ENV_TOKEN }]))
  const stores = await project('alpha')
  const server = await start()
  const token = await enroll(server)
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  expect(await (await worker(server, 'poll', { poll: 1 }, { token })).json()).toEqual({ job: null })
  expect((await worker(server, 'poll', { poll: 1 }, { node: 'env-box', token: ENV_TOKEN })).status).toBe(200)
  await enqueueTeamJob(stores, { ...jobInput, id: 'running' })
  await enqueueTeamJob(stores, { ...jobInput, id: 'queued' })
  const { job } = await (await worker(server, 'poll', { poll: 2 }, { token })).json()
  const claim = { id: job.id, claimId: job.claimId }
  expect(await (await worker(server, 'heartbeat', claim, { token })).json()).toEqual({ leaseMs: TEAM_LEASE_MS })
  expect(await (await device(server)).json()).toMatchObject({ devices: [
    { nodeId: 'desktop', status: 'online', jobId: 'running', lastSeenAt: new Date(now).toISOString() },
    { nodeId: 'env-box', status: 'online' },
  ] })
  expect(await (await device(server, `${dev}/desktop`, 'DELETE')).json()).toEqual({ ok: true })
  expect(await teamNodes(stores)).toEqual([{ id: 'env-box', harness: 'codex', online: true }])
  expect((await teamJobs(stores)).map(({ id, status }) => [id, status])).toEqual([['running', 'failed'], ['queued', 'failed']])
  await expect(enqueueTeamJob(stores, { ...jobInput, id: 'stale' })).rejects.toMatchObject({ status: 409 })
  expect((await worker(server, 'poll', { poll: 2 }, { token })).status).toBe(401)
  expect((await worker(server, 'heartbeat', claim, { token })).status).toBe(401)
  const replacement = await enroll(server)
  expect((await worker(server, 'finish', { ...claim, status: 'succeeded', result: 'done' }, { token: replacement })).status).toBe(409)
  expect(await (await worker(server, 'poll', { poll: 1 }, { token: replacement })).json()).toEqual({ job: null })
  await enqueueTeamJob(stores, { ...jobInput, id: 'new-job' })
  const next = await (await worker(server, 'poll', { poll: 2 }, { token: replacement })).json()
  expect(next.job.id).toBe('new-job')
  expect((await worker(server, 'finish', { id: next.job.id, claimId: next.job.claimId, status: 'succeeded', result: 'done' }, { token: replacement })).status).toBe(200)
  now += TEAM_LEASE_MS
  expect(await (await device(server)).json()).toMatchObject({ devices: [
    { nodeId: 'desktop', status: 'offline', lastSeenAt: expect.any(String) }, { nodeId: 'env-box', status: 'offline' },
  ] })
})

it('撤销持有登记锁直到清除作业，等待中的工作请求不能拿到旧作业', async () => {
  const stores = await project('alpha')
  const hub = await start()
  const other = await start()
  const token = await enroll(hub)
  expect((await worker(hub, 'poll', { poll: 1 }, { token })).status).toBe(200)
  await enqueueTeamJob(stores, { ...jobInput, id: 'waiting' })
  const workFile = join(stores.taktDir, 'runs', '.team-hub', 'state.json')
  const linkLock = join(root, '.takt-team-link', `${sha256('alpha')}.json.lock`)
  let revoke!: Promise<Response>
  let poll!: Promise<Response>
  await teamFileLock(storagePath(workFile), async () => {
    revoke = device(hub, `${dev}/desktop`, 'DELETE')
    await vi.waitFor(async () => expect((await lstat(linkLock)).isFile()).toBe(true))
    poll = worker(other, 'poll', { poll: 2 }, { token })
  })
  expect((await revoke).status).toBe(200)
  expect((await poll).status).toBe(401)
  expect((await teamJobs(stores))[0]?.status).toBe('failed')
  expect(await teamNodes(stores)).toEqual([])
  await Promise.all([hub.close(), other.close()])
  const restarted = await start()
  expect((await worker(restarted, 'poll', { poll: 2 }, { token })).status).toBe(401)
})

it('切换未登记的旧节点 ID 到 Link 时不接管环境变量时代的运行和排队记录', async () => {
  vi.stubEnv('TAKT_TEAM_NODES', JSON.stringify([{ spaceId: 'alpha', nodeId: 'desktop', harness: 'codex', token: ENV_TOKEN }]))
  const stores = await project('alpha')
  let server = await start()
  expect((await worker(server, 'poll', { poll: 1 }, { token: ENV_TOKEN })).status).toBe(200)
  await enqueueTeamJob(stores, { ...jobInput, id: 'legacy-running' })
  await enqueueTeamJob(stores, { ...jobInput, id: 'legacy-queued' })
  const { job } = await (await worker(server, 'poll', { poll: 2 }, { token: ENV_TOKEN })).json()
  await server.close()
  vi.stubEnv('TAKT_TEAM_NODES', undefined)
  server = await start()
  expect(await (await device(server)).json()).toEqual({ spaceId: 'alpha', devices: [] })
  const token = await enroll(server)
  expect((await worker(server, 'heartbeat', { id: job.id, claimId: job.claimId }, { token })).status).toBe(409)
  expect(await (await worker(server, 'poll', { poll: 1 }, { token })).json()).toEqual({ job: null })
  expect((await teamJobs(stores)).map(({ id, status }) => [id, status])).toEqual([['legacy-running', 'failed'], ['legacy-queued', 'failed']])
})

it('配置破坏或符号链接时关闭私有注册表，不写入链接目标', async () => {
  await project('alpha')
  const hub = await start()
  const registry = join(root, '.takt-team-link')
  const outside = join(root, 'outside')
  await mkdir(outside, { mode: 0o700 })
  await symlink(outside, registry, 'dir')
  expect((await device(hub, `${dev}/link`, 'POST', 'owner', linkInput)).status).toBe(500)
  expect(await readdir(outside)).toEqual([])
  await rm(registry)
  const { code } = await issue(hub)
  const file = join(registry, `${sha256('alpha')}.json`)
  const copy = join(outside, 'registry.json')
  await writeFile(copy, await readFile(file), { mode: 0o600 })
  await rm(file)
  await symlink(copy, file)
  expect((await device(hub)).status).toBe(500)
  expect((await worker(hub, 'link', { code })).status).toBe(500)
  await rm(file)
  await writeFile(file, await readFile(copy), { mode: 0o600 })
  await chmod(file, 0o644)
  expect((await worker(hub, 'link', { code })).status).toBe(500)
  await chmod(file, 0o600)
  expect((await worker(hub, 'link', { code })).status).toBe(200)
})

it('在写入登记前按同一配置锁重新检查 owner 权限', async () => {
  const stores = await project('alpha', root)
  const server = await start(true)
  const path = join(root, 'takt.config.json')
  let reply!: Promise<number | undefined>
  await teamFileLock(storagePath(path), async () => {
    reply = new Promise((resolve, reject) => {
      const client = httpRequest(server.url + `${dev}/link`, { method: 'POST', headers: { ...jsonHeaders, 'x-takt-user': 'owner' } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      client.on('error', reject)
      client.end(JSON.stringify(linkInput))
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const config = stores.config
    const members = config.members!.map(member => member.id === 'owner' ? { ...member, role: 'viewer' } : member)
    await writeFile(path, JSON.stringify({ ...config, members }))
  })
  expect(await reply).toBe(403)
  await expect(lstat(join(root, '.takt', 'runs', '.team-link'))).rejects.toMatchObject({ code: 'ENOENT' })
})
