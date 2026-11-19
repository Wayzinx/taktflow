import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject, openProject } from '@taktflow/core'
import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type RunningServer } from './index.js'
import { enqueueTeamJob, teamJobs, teamNodes, TEAM_LEASE_MS } from './team-hub.js'

const FIRST = 'a'.repeat(43), SECOND = 'b'.repeat(43), THIRD = 'c'.repeat(43)
const newJob = { id: 'task-1', nodeId: 'desktop', harness: 'codex', prompt: 'Update the README', actorId: 'alice' }
let root: string
let server: RunningServer | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await server?.close()
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
})

async function setup(enabled: boolean) {
  const admission = (spaceId: string, nodeId: string, token: string) => ({ spaceId, nodeId, harness: 'codex', token })
  vi.stubEnv('TAKT_TEAM_NODES', enabled ? JSON.stringify([
    admission('alpha', 'desktop', FIRST), admission('alpha', 'other', SECOND), admission('beta', 'desktop', THIRD),
  ]) : undefined)
  root = await mkdtemp(join(tmpdir(), 'takt-team-hub-'))
  const alpha = await initProject(join(root, 'alpha'))
  const beta = await initProject(join(root, 'beta'))
  server = await createServer({ spacesDir: root, port: 0 })
  return { alpha, beta }
}

function request(action: string, input: object, auth = { space: 'alpha', node: 'desktop', token: FIRST }, headers?: Record<string, string>) {
  return fetch(`${server!.url}/api/team-worker/v1/${auth.space}/${auth.node}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}`, ...headers },
    body: JSON.stringify({ harness: 'codex', session: 'instance-a', ...input }),
  })
}

it('默认关闭 Worker API 且不会从人类请求头推导准入', async () => {
  const { alpha } = await setup(false)
  const response = await request('poll', { poll: 1 }, undefined, { 'x-takt-user': 'alice' })
  expect(response.status).toBe(404)
  expect(await teamNodes(alpha)).toEqual([])
  await expect(enqueueTeamJob(alpha, newJob)).rejects.toMatchObject({ status: 409 })
})

it('token 绑定空间、节点、harness，隔离各空间的任务与节点', async () => {
  const { alpha, beta } = await setup(true)
  for (const auth of [{ space: 'beta', node: 'desktop', token: FIRST }, { space: 'alpha', node: 'other', token: FIRST }]) {
    expect((await request('poll', { poll: 1 }, auth)).status).toBe(401)
  }
  expect((await request('poll', { poll: 1, harness: 'other' })).status).toBe(403)
  expect((await request('poll', { poll: 1 }, undefined, { origin: 'http://localhost:5173' })).status).toBe(403)
  expect((await request('poll', { poll: 1 }, undefined, { 'content-type': 'text/plain' })).status).toBe(415)
  const admitted = await request('poll', { poll: 1 })
  expect(admitted.headers.get('cache-control')).toBe('no-store')
  expect(await admitted.json()).toEqual({ job: null })
  expect(await teamNodes(alpha)).toEqual([{ id: 'desktop', harness: 'codex', online: true }])
  expect(await teamNodes(beta)).toEqual([])
  await expect(enqueueTeamJob(alpha, { ...newJob, harness: 'other' })).rejects.toMatchObject({ status: 409 })
  await enqueueTeamJob(alpha, newJob)
  expect(await (await request('poll', { poll: 1 }, { space: 'beta', node: 'desktop', token: THIRD })).json()).toEqual({ job: null })
  expect(await teamJobs(beta)).toEqual([])
  expect(await teamJobs(alpha)).toEqual([{ id: 'task-1', nodeId: 'desktop', harness: 'codex', status: 'queued' }])
})

it('轮询与完成可重放，互斥认领、续租、持久结果，过期任务不会重新排队', async () => {
  const { alpha } = await setup(true)
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  expect(await (await request('poll', { poll: 1 })).json()).toEqual({ job: null })
  await Promise.all(Array.from({ length: 4 }, () => expect(enqueueTeamJob(alpha, newJob)).resolves.toEqual({ id: newJob.id })))
  await expect(enqueueTeamJob(alpha, { ...newJob, prompt: 'Different payload' })).rejects.toMatchObject({ status: 409 })
  expect(await (await request('poll', { poll: 1 })).json()).toEqual({ job: null })
  const claims = await Promise.all([request('poll', { poll: 2 }), request('poll', { poll: 2 })].map(async (response) => (await response).json()))
  expect(claims[0]).toEqual({ job: { id: newJob.id, claimId: expect.any(String), prompt: newJob.prompt } })
  expect(claims[0]).toEqual(claims[1])
  const { id, claimId } = claims[0].job
  expect((await request('poll', { poll: 1 })).status).toBe(409)
  expect((await request('poll', { poll: 3 })).status).toBe(409)
  expect((await request('poll', { session: 'instance-b', poll: 1 })).status).toBe(409)
  expect((await request('heartbeat', { id, claimId, session: 'instance-b' })).status).toBe(409)
  now += TEAM_LEASE_MS - 1
  expect(await (await request('heartbeat', { id, claimId })).json()).toEqual({ leaseMs: TEAM_LEASE_MS })
  now += 2
  expect((await teamJobs(alpha))[0]?.status).toBe('running')
  const outcome = { id, claimId, status: 'succeeded', result: 'Updated' }
  expect((await request('finish', { ...outcome, result: '界'.repeat(6000) })).status).toBe(400)
  expect((await request('finish', outcome)).status).toBe(200)
  await server!.close()
  server = await createServer({ spacesDir: root, port: 0 })
  expect((await request('finish', outcome)).status).toBe(200)
  expect((await request('finish', { ...outcome, result: 'Conflicting outcome' })).status).toBe(409)
  expect(await (await request('poll', { poll: 2 })).json()).toEqual({ job: null })
  await enqueueTeamJob(alpha, { ...newJob, id: 'lost' })
  await enqueueTeamJob(alpha, { ...newJob, id: 'next' })
  const { job: lost } = await (await request('poll', { poll: 3 })).json()
  now += TEAM_LEASE_MS
  expect((await teamNodes(alpha))[0]?.online).toBe(false)
  await expect(enqueueTeamJob(alpha, { ...newJob, id: 'offline' })).rejects.toMatchObject({ status: 409 })
  await expect(enqueueTeamJob(alpha, newJob)).resolves.toEqual({ id: newJob.id })
  const persisted = await teamJobs(await openProject(alpha.projectDir))
  expect(persisted.map((job) => [job.id, job.status, job.result])).toEqual([
    ['task-1', 'succeeded', 'Updated'], ['lost', 'failed', expect.stringContaining('未自动重试')], ['next', 'queued', undefined],
  ])
  expect((await request('finish', { ...outcome, id: lost.id, claimId: lost.claimId })).status).toBe(409)
  expect((await (await request('poll', { session: 'instance-b', poll: 1 })).json()).job.id).toBe('next')
  const state = await readFile(join(alpha.taktDir, 'runs', '.team-hub', 'state.json'), 'utf8')
  expect(await alpha.runs.list()).toEqual([])
  expect(state).not.toContain(FIRST)
  expect(state).toContain(newJob.actorId)
})
