import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer as httpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { initProject } from '@taktflow/core'
import { createServer, enqueueTeamJob, teamJobs, teamNodes, type RunningServer } from '@taktflow/server'
import { afterEach, expect, it, vi } from 'vitest'
import { runTeamWorker } from './worker.js'

const TOKEN = 'x'.repeat(43)
let root: string | undefined
let hub: RunningServer | undefined
let proxy: Server | undefined
let child: ChildProcess | undefined

afterEach(async () => {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  child = undefined
  if (proxy) {
    proxy.closeAllConnections()
    await new Promise<void>((done) => proxy!.close(() => done()))
    proxy = undefined
  }
  await hub?.close()
  hub = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

it('拒绝非本机明文 HTTP、URL 凭据和跳过证书验证', async () => {
  const options = { node: 'desktop', space: 'alpha', harness: 'codex', project: '/unused', token: TOKEN }
  const signal = new AbortController().signal
  await expect(runTeamWorker({ ...options, hub: 'http://example.test' }, signal)).rejects.toThrow('HTTPS')
  await expect(runTeamWorker({ ...options, hub: 'https://user:secret@example.test' }, signal)).rejects.toThrow('凭据')
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
  await expect(runTeamWorker({ ...options, hub: 'https://example.test' }, signal)).rejects.toThrow('证书验证')
})

it('CLI 通过 HTTP 续租，轮询与完成响应丢失不重复执行，prompt 只走 stdin', async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-live-worker-'))
  const checkout = join(root, 'checkout')
  await mkdir(checkout)
  const workspace = await realpath(checkout)
  const bin = join(root, 'bin'), home = join(root, 'home')
  await Promise.all([mkdir(bin), mkdir(home)])
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync('invocations.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, env: Object.keys(process.env) }) + '\\n');
if (prompt === 'Fail locally') process.exit(7);
setTimeout(() => process.stdout.write('Codex output\\n' + '界'.repeat(9000)), 5300);
`, { mode: 0o700 })
  const stores = await initProject(join(root, 'alpha'))
  vi.stubEnv('TAKT_TEAM_NODES', JSON.stringify([{ spaceId: 'alpha', nodeId: 'desktop', harness: 'codex', token: TOKEN }]))
  hub = await createServer({ projectDir: stores.projectDir, port: 0 })
  const network = { pollLost: false, finishLost: false, finishes: 0, heartbeats: 0 }
  proxy = httpServer((request, response) => {
    void (async () => {
      const upstream = new URL(request.url!, hub!.url)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const result = await fetch(upstream, {
        method: 'POST', headers: { authorization: request.headers.authorization!, 'content-type': 'application/json' }, body: Buffer.concat(chunks),
      })
      const data = await result.text()
      if (upstream.pathname.endsWith('/poll') && JSON.parse(data).job && !network.pollLost) {
        network.pollLost = true
        response.destroy()
      } else if (upstream.pathname.endsWith('/finish') && result.ok && !network.finishLost) {
        network.finishes++
        network.finishLost = true
        response.destroy()
      } else {
        if (upstream.pathname.endsWith('/finish') && result.ok) network.finishes++
        if (upstream.pathname.endsWith('/heartbeat') && result.ok) network.heartbeats++
        response.writeHead(result.status, { 'content-type': 'application/json' }).end(data)
      }
    })().catch(() => response.destroy())
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const endpoint = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  child = spawn(process.execPath, [resolve('packages/cli/dist/index.js'), 'worker', '--hub', endpoint, '--space', 'alpha',
    '--node', 'desktop', '--harness', 'codex', '--project', workspace], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
      TAKT_TEAM_TOKEN: TOKEN, OPENAI_API_KEY: 'not-for-harness', SENSITIVE_VAR: 'not-for-harness' },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  child.stdin!.end(`${TOKEN}\n`)
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  await vi.waitFor(async () => expect(await teamNodes(stores), stderr).toEqual([{ id: 'desktop', harness: 'codex', online: true }]), { timeout: 5000 })
  const prompt = '--dangerously-bypass-approvals-and-sandbox\n$(touch not-a-command)'
  const job = { id: 'job-1', nodeId: 'desktop', harness: 'codex', prompt, actorId: 'alice' }
  await enqueueTeamJob(stores, job)
  await enqueueTeamJob(stores, { ...job, id: 'job-2', prompt: 'Fail locally' })
  await vi.waitFor(() => expect(network.finishes, stderr).toBe(3), { timeout: 15_000 })
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  expect(await exited).toEqual([0, null])
  expect(network).toMatchObject({ pollLost: true, finishLost: true, finishes: 3 })
  expect(network.heartbeats).toBeGreaterThanOrEqual(3)
  const entries = (await readFile(join(workspace, 'invocations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  expect(entries.map((entry) => entry.prompt)).toEqual([prompt, 'Fail locally'])
  expect(entries[0]).toMatchObject({ cwd: workspace, argv: expect.arrayContaining(['exec', '--sandbox', 'workspace-write']) })
  expect(entries[0].argv.at(-1)).toBe('-')
  expect(entries[0].argv).not.toContain(prompt)
  expect(entries[0].env).toEqual(expect.arrayContaining(['HOME', 'PATH', 'CODEX_HOME']))
  for (const key of ['TAKT_TEAM_TOKEN', 'OPENAI_API_KEY', 'TAKT_TEAM_NODES', 'SENSITIVE_VAR']) expect(entries[0].env).not.toContain(key)
  const [success, failure] = await teamJobs(stores)
  expect(success).toMatchObject({ status: 'succeeded', result: expect.stringMatching(/^Codex output.*输出已截断\)$/s) })
  expect(Buffer.byteLength(success!.result!)).toBeLessThanOrEqual(16 * 1024)
  expect(failure).toMatchObject({ status: 'failed', result: expect.stringContaining('7') })
  expect(stderr).not.toContain(TOKEN)
})
