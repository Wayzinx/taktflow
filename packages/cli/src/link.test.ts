import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { teamEndpoint } from './team-transport.js'

interface Request { path: string; method: string; authorization?: string; contentType?: string; body: unknown }
const CODE = randomBytes(24).toString('base64url')
const TOKEN = randomBytes(32).toString('base64url')
const ROTATED = randomBytes(32).toString('base64url')
const ROUTE = '/team/api/team-worker/v1/alpha/desktop/'
let root: string, checkout: string, state: string, home: string, bin: string, hub: string
let server: Server
let requests: Request[]
let children: Set<ChildProcess>
let respond: (request: Request, response: ServerResponse) => void

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-cli-link-'))
  checkout = join(root, 'checkout')
  state = join(root, 'isolated', 'links')
  home = join(root, 'home')
  bin = join(root, 'bin')
  await Promise.all([mkdir(checkout), mkdir(home), mkdir(bin)])
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  requests = []
  children = new Set()
  respond = ({ path }, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(path.endsWith('/link') ? { token: TOKEN } : { job: null }))
  }
  server = createServer((request, response) => {
    let data = ''
    request.setEncoding('utf8').on('data', (chunk) => { data += chunk })
    request.once('end', () => {
      const captured = { path: request.url!, method: request.method!, authorization: request.headers.authorization,
        contentType: request.headers['content-type'], body: data ? JSON.parse(data) : null }
      requests.push(captured)
      respond(captured, response)
    })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}/team`
})

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
  }))
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  await rm(root, { recursive: true, force: true })
})

const args = (url = hub, space = 'alpha', node = 'desktop', project = checkout) =>
  ['--hub', url, '--space', space, '--node', node, '--project', project]

function start(flags: string[], input: string | null = '', env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [resolve('packages/cli/dist/index.js'), 'link', ...flags], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), TAKT_WORKER_CODEX_HOME: undefined,
      TAKT_LINK_DIR: state, PATH: [bin, process.env.PATH].join(delimiter), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (data) => { output += data })
  child.stderr.setEncoding('utf8').on('data', (data) => { output += data })
  child.stdin.on('error', () => {})
  if (input !== null) child.stdin.end(input)
  const done = once(child, 'close').then(([status, signal]) => {
    children.delete(child)
    return { status, signal, output }
  })
  return { child, done }
}

async function pollAndStop(command: ReturnType<typeof start>, token: string, signal: NodeJS.Signals = 'SIGTERM') {
  await vi.waitFor(() => expect(requests.at(-1)?.path).toBe(`${ROUTE}poll`), { timeout: 2500 })
  expect(requests.at(-1)?.authorization === `Bearer ${token}`).toBe(true)
  expect(requests.at(-1)?.body).toMatchObject({ harness: 'codex', poll: 1, session: expect.any(String) })
  command.child.kill(signal)
  return command.done
}

async function credential(dir = state) {
  const files = await readdir(dir)
  expect(files).toHaveLength(1)
  return join(dir, files[0]!)
}

it('通过真实 CLI 入口保存私有凭据；等价 Hub 地址复用凭据，且不读取 stdin', async () => {
  expect(await pollAndStop(start(args(), `${CODE}\r\n`), TOKEN)).toMatchObject({ status: 0, signal: null, output: '' })
  expect(requests.map(({ path }) => path)).toEqual([`${ROUTE}link`, `${ROUTE}poll`])
  expect(requests[0]).toMatchObject({ method: 'POST', contentType: 'application/json' })
  expect(requests[0]?.authorization).toBeUndefined()
  expect(JSON.stringify(requests[0]?.body) === JSON.stringify({ code: CODE, harness: 'codex' })).toBe(true)
  const file = await credential()
  expect((await stat(state)).mode & 0o777).toBe(0o700)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(file, 'utf8')).token === TOKEN).toBe(true)
  expect((await readFile(file, 'utf8')).includes(CODE)).toBe(false)
  expect(await readdir(checkout)).toEqual([])

  requests.length = 0
  expect(await pollAndStop(start(args(`${hub}/`), null), TOKEN, 'SIGINT')).toMatchObject({ status: 0, signal: null, output: '' })
  expect(requests.map(({ path }) => path)).toEqual([`${ROUTE}poll`])
})

it('401 时提示显式重新配对；配对失败不删除旧凭据，成功才替换', async () => {
  await pollAndStop(start(args(), CODE), TOKEN)
  const file = await credential()
  const previous = await readFile(file, 'utf8')
  requests.length = 0
  respond = ({ path }, response) => {
    response.writeHead(path.endsWith('/link') ? 400 : 401).end(JSON.stringify({ message: `${CODE} ${TOKEN}` }))
  }
  const rejected = await start(args()).done
  expect(rejected).toMatchObject({ status: 1, output: expect.stringContaining('--relink') })
  expect((await start([...args(), '--relink'], CODE).done).status).toBe(1)
  expect((await readFile(file, 'utf8')) === previous).toBe(true)
  expect([CODE, TOKEN].some(secret => rejected.output.includes(secret))).toBe(false)
  expect(requests.map(({ path }) => path)).toEqual([`${ROUTE}poll`, `${ROUTE}link`])

  respond = ({ path }, response) => response.end(JSON.stringify(path.endsWith('/link') ? { token: ROTATED } : { job: null }))
  requests.length = 0
  expect((await pollAndStop(start([...args(), '--relink'], CODE), ROTATED)).status).toBe(0)
  expect(JSON.parse(await readFile(file, 'utf8')).token === ROTATED).toBe(true)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
})

it('不跨 Hub、空间或节点使用已存凭据，也不覆盖重复的目的地参数', async () => {
  await pollAndStop(start(args(), CODE), TOKEN)
  requests.length = 0
  for (const flags of [args(hub, 'beta'), args(hub, 'alpha', 'other'), args(`${hub}/other`),
    [...args(), '--hub', `${hub}/other`], [...args(), '--space=beta'], [...args(), '--node', 'other'],
    [...args(), '--project', home], args(hub, '..'), args(hub, 'alpha', 'a/b'), args(hub, 'alpha', 'desktop', join(root, 'missing'))]) {
    expect((await start(flags).done).status).toBe(2)
  }
  expect(requests).toEqual([])
  expect(await readdir(state)).toHaveLength(1)
})

it('默认写到 HOME，拒绝普通 HTTP、URL 凭据、query、fragment 与跳转', async () => {
  expect((await start(args('http://example.test'), CODE).done).status).toBe(2)
  for (const url of [`${hub}?`, `${hub}#`, hub.replace('://', `://user:${CODE}@`), 'https:///host.test']) {
    const rejected = await start(args(url), CODE).done
    expect(rejected.status).toBe(2)
    expect(rejected.output.includes(CODE)).toBe(false)
  }
  expect((await start(args('https://example.test'), CODE, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }).done).status).toBe(2)
  expect(requests).toEqual([])

  respond = (_request, response) => response.writeHead(307, { location: `${hub}/capture` }).end(`${CODE} ${TOKEN}`)
  const redirected = await start(args(), CODE).done
  expect(redirected).toMatchObject({ status: 1, output: expect.stringContaining('307') })
  expect([CODE, TOKEN].some(secret => redirected.output.includes(secret))).toBe(false)
  expect(requests.map(({ path }) => path)).toEqual([`${ROUTE}link`])
  expect(await readdir(state)).toEqual([])

  requests.length = 0
  respond = ({ path }, response) => response.end(JSON.stringify(path.endsWith('/link') ? { token: TOKEN } : { job: null }))
  await pollAndStop(start(args(), CODE, { TAKT_LINK_DIR: undefined }), TOKEN)
  expect((await stat(await credential(join(home, '.takt-link')))).mode & 0o777).toBe(0o600)
})

it('拒绝不安全的目录、文件、checkout 及改名的凭据', async () => {
  await mkdir(state, { recursive: true, mode: 0o755 })
  expect((await start(args(), CODE).done).output).toContain('0700')
  expect((await start(args(), CODE, { TAKT_LINK_DIR: join(checkout, 'links') }).done).status).toBe(2)
  const alias = join(root, 'alias')
  await symlink(checkout, alias)
  expect((await start(args(), CODE, { TAKT_LINK_DIR: join(alias, 'links') }).done).status).toBe(2)
  const rootLink = join(root, 'root-link')
  await symlink(state, rootLink)
  expect((await start(args(), CODE, { TAKT_LINK_DIR: rootLink }).done).output).toContain('不安全')
  expect(requests).toEqual([])
  expect(await readdir(checkout)).toEqual([])

  await chmod(state, 0o700)
  await pollAndStop(start(args(), CODE), TOKEN)
  const file = await credential()
  const hardlink = join(root, 'hardlink')
  requests.length = 0
  await chmod(file, 0o644)
  expect((await start([...args(), '--relink'], CODE).done).output).toContain('0600')
  await chmod(file, 0o600)
  await link(file, hardlink)
  expect((await start(args(), CODE).done).output).toContain('不安全')
  await rm(file)
  await symlink(hardlink, file)
  expect((await start(args(), CODE).done).output).toContain('不安全')
  await rm(file)
  await writeFile(file, JSON.stringify({ key: 'different-destination', token: TOKEN }), { mode: 0o600 })
  expect((await start(args(), CODE).done).output).toContain('不属于该目标')
  expect(requests).toEqual([])
})

it('仅接受 stdin 的单行 ASCII 配对码，不回显无效输入或响应', async () => {
  for (const invalid of ['', 'short', ` ${CODE}`, `${CODE}\n${CODE}\n`, `${CODE}\u00e9`, 'a'.repeat(259)]) {
    const rejected = await start(args(), invalid).done
    expect(rejected.status).toBe(2)
    expect(rejected.output.includes(CODE)).toBe(false)
  }
  for (const positional of [CODE, `--code=${CODE}`, `-${CODE}`]) {
    const rejected = await start([...args(), positional]).done
    expect(rejected.status).toBe(2)
    expect(rejected.output.includes(CODE)).toBe(false)
  }
  expect(requests).toEqual([])
  respond = (_request, response) => response.end(JSON.stringify({ token: `${TOKEN}\n` }))
  const invalidReply = await start(args(), CODE).done
  expect(invalidReply).toMatchObject({ status: 1, output: expect.stringContaining('链接凭据无效') })
  expect(invalidReply.output.includes(TOKEN)).toBe(false)
  expect(await readdir(state)).toEqual([])
})

it('帮助公开 link、stdin 和 --relink；HTTPS 归一化不丢失代理路径', async () => {
  expect(await start(['--help']).done).toMatchObject({ status: 0, output: expect.stringContaining('link --hub URL --space ID --node ID') })
  expect(teamEndpoint({ hub: 'HTTPS://EXAMPLE.TEST:443/team/', space: 'alpha', node: 'desktop' }).href)
    .toBe(`https://example.test${ROUTE}`)
  expect(teamEndpoint({ hub: 'http://[::1]:80/team', space: 'alpha', node: 'desktop' }).href)
    .toBe(`http://[::1]${ROUTE}`)
})

it('不向环境代理发送链接码或 Worker 凭据', async () => {
  let forwarded = false
  const proxy = createServer((_request, response) => {
    forwarded = true
    response.writeHead(403).end()
  }).listen(0, '127.0.0.1')
  proxy.on('connect', (_request, socket) => {
    forwarded = true
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await once(proxy, 'listening')
  const address = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  try {
    const result = await pollAndStop(start(args(), CODE, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: address,
      http_proxy: address, NO_PROXY: '', no_proxy: '', NODE_DEBUG: 'http,https' }), TOKEN)
    expect(result.status).toBe(0)
    expect([CODE, TOKEN].some(secret => result.output.includes(secret))).toBe(false)
    expect(forwarded).toBe(false)
  } finally {
    proxy.closeAllConnections()
    await new Promise<void>((done) => proxy.close(() => done()))
  }
})
