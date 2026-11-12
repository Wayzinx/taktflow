import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openProject } from '@taktflow/core'
import { createServer, type RunningServer } from './index.js'
import { initSpace } from './space-admin.js'
import { repoManager } from './space.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const gitRepo = async (dir: string, branch = 'main') => {
  await mkdir(dir, { recursive: true })
  for (const args of [['init', '-b', branch], ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'base']]) execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-repo-routes-')); roots.push(root)
  const stores = await initSpace(root, 'blank', { name: '仓库' })
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, members: [{ id: 'alice', name: 'alice', role: 'owner' }, { id: 'bob', name: 'bob', role: 'maintainer' }, { id: 'carol', name: 'carol', role: 'member' }] }))
  const server = await createServer({ projectDir: root, port: 0 }); servers.push(server)
  const request = async (path: string, method: string, data?: unknown, user = 'bob') => {
    const response = await fetch(`${server.url}/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-takt-user': user }, body: data === undefined ? undefined : JSON.stringify(data) })
    return { status: response.status, data: await response.json() as any }
  }
  const repoOf = async (id: string) => (await request('/space', 'GET')).data.repos.find((repo: { id: string }) => repo.id === id)
  return { root, request, repoOf }
}

it('绑定时校验远程地址形态和本地目录；仓库 id 报错说明规则', async () => {
  const { root, request } = await setup()
  const bogus = await request('/space/repos', 'POST', { id: 'qa-admin-r1', url: 'not a url at all', path: '.takt/repos/qa-admin-r1', defaultBranch: 'main', reason: '绑定' })
  expect(bogus.status).toBe(400)
  expect(bogus.data.error).toContain('远程地址不合法：not a url at all')
  expect((await request('/space/repos', 'POST', { id: 'QA admin', url: 'https://example.com/a.git', path: '.takt/repos/x', defaultBranch: 'main', reason: '绑定' })).data.error).toBe('仓库 id 不合法：QA admin。只能用字母、数字、短横线和下划线，并以字母或数字开头')
  for (const [i, url] of ['https://example.com/a.git', 'git@github.com:org/repo.git', 'ssh://git@host/repo', 'file:///srv/repo.git', '/srv/mirror/repo.git'].entries())
    expect((await request('/space/repos', 'POST', { id: `r${i}`, url, path: `.takt/repos/r${i}`, defaultBranch: 'main', reason: '绑定' })).status, url).toBe(200)
  // 本地目录：必须是已有 git 仓库的根目录，且有默认分支
  expect((await request('/space/repos', 'POST', { id: 'local', path: 'nope', defaultBranch: 'main', reason: '绑定' })).data.error).toBe('本地目录不存在或不是 git 仓库：nope')
  await gitRepo(join(root, 'app')); await mkdir(join(root, 'app/src'))
  expect((await request('/space/repos', 'POST', { id: 'local', path: 'app/src', defaultBranch: 'main', reason: '绑定' })).data.error).toContain('在另一个 git 仓库里')
  expect((await request('/space/repos', 'POST', { id: 'local', path: 'app', defaultBranch: 'dev', reason: '绑定' })).data.error).toBe('本地仓库没有默认分支 dev，请检查分支名')
  const bound = await request('/space/repos', 'POST', { id: 'local', path: 'app', defaultBranch: 'main', reason: '绑定' })
  expect(bound.data.repos.find((repo: { id: string }) => repo.id === 'local').status).toBe('ready')
})

it('同步失败返回 git 的具体原因并记成"同步失败"，改对地址同步后恢复；已有镜像跟着换远程', async () => {
  const { root, request, repoOf } = await setup()
  await request('/space/repos', 'POST', { id: 'r1', url: `file://${join(root, 'missing.git')}`, path: '.takt/repos/r1', defaultBranch: 'main', reason: '绑定' })
  const failed = await request('/space/repos/r1/sync', 'POST', { reason: '同步' })
  expect(failed.status).toBe(502)
  expect(failed.data.error).toMatch(/^同步失败（克隆 file:\/\/.+missing\.git）：.+/)
  expect(failed.data.error).not.toBe('服务器内部错误')
  expect(await repoOf('r1')).toMatchObject({ status: 'error', message: failed.data.error })
  await request('/space/repos', 'POST', { id: 'secret', url: 'https://user:s3cr3t@127.0.0.1:1/repo.git', path: '.takt/repos/secret', defaultBranch: 'main', reason: '绑定' })
  const leaked = await request('/space/repos/secret/sync', 'POST', { reason: '同步' })
  expect(leaked.status).toBe(502)
  expect(leaked.data.error).not.toContain('s3cr3t')
  // 改对地址：失败原因清掉，同步成功
  const first = await gitRepo(join(root, 'remote-a'))
  await request('/space/repos/r1', 'PATCH', { url: join(root, 'remote-a'), reason: '改地址' })
  expect((await repoOf('r1')).status).toBe('missing')
  expect((await request('/space/repos/r1/sync', 'POST', { reason: '同步' })).data.head).toBe(first)
  expect(await repoOf('r1')).toMatchObject({ status: 'ready', head: first })
  expect((await repoOf('r1')).message).toBeUndefined()
  const second = await gitRepo(join(root, 'remote-b'))
  await request('/space/repos/r1', 'PATCH', { url: join(root, 'remote-b'), reason: '换远程' })
  expect((await request('/space/repos/r1/sync', 'POST', { reason: '同步' })).data.head).toBe(second)
  expect((await request('/space/repos/r1', 'PATCH', { url: 'not a url', reason: '改坏' })).status).toBe(400)
})

it('解绑仓库：要 maintainer 和原因，运行中的任务在用它的工作区时拒绝并列出，不删磁盘上的目录', async () => {
  const { root, request, repoOf } = await setup()
  await gitRepo(join(root, 'app'))
  await gitRepo(join(root, 'remote'))
  await request('/space/repos', 'POST', { id: 'app', path: 'app', defaultBranch: 'main', reason: '绑定' })
  await request('/space/repos', 'POST', { id: 'mirror', url: join(root, 'remote'), path: '.takt/repos/mirror', defaultBranch: 'main', reason: '绑定' })
  await request('/space/repos/mirror/sync', 'POST', { reason: '同步' })
  expect((await request('/space/repos/app', 'DELETE', { reason: '绑错了' }, 'carol')).data.error).toContain('解绑代码仓库需要 maintainer')
  expect((await request('/space/repos/app', 'DELETE', {})).status).toBe(400)
  expect((await request('/space/repos/none', 'DELETE', { reason: '绑错了' })).status).toBe(404)
  const stores = await openProject(root)
  await stores.runs.create({ runId: 'busy-run', requirementId: 'REQ-1', workflowId: 'test', status: 'running', startedAt: new Date().toISOString(), nodes: {}, expansions: [], args: {} } as never, { id: 'test', title: 'test', version: '1', stages: [], nodes: [] })
  await repoManager(stores).createWorktree({ repoId: 'app', runId: 'busy-run', nodeId: 'dev' })
  const busy = await request('/space/repos/app', 'DELETE', { reason: '绑错了' })
  expect(busy.status).toBe(409)
  expect(busy.data.error).toContain('busy-run')
  // 另一个仓库没有被占用，可以解绑；镜像目录保留
  const removed = await request('/space/repos/mirror', 'DELETE', { reason: '不再需要' })
  expect(removed.status, JSON.stringify(removed.data)).toBe(200)
  expect(removed.data.repos.map((repo: { id: string }) => repo.id)).toEqual(['app'])
  await access(join(root, '.takt/repos/mirror'))
  expect(await repoOf('mirror')).toBeUndefined()
  // 运行结束后可以解绑本地仓库，目录还在
  await stores.runs.save({ ...(await stores.runs.get('busy-run'))!, status: 'succeeded' })
  expect((await request('/space/repos/app', 'DELETE', { reason: '绑错了' })).data.repos).toEqual([])
  await access(join(root, 'app/.git'))
})
