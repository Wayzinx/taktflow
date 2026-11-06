import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireLease, initProject, releaseLease, type ProjectStores, type RunState } from '@taktflow/core'
import { main } from './index.js'
import { repoRoot } from './project.js'
import { removeTestProject } from '../../server/src/test-cleanup.js'

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await exited
  }
  await Promise.all(roots.splice(0).map(removeTestProject))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-quality-cli-')); roots.push(root)
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: '质量' })
  return stores
}

async function cli(stores: ProjectStores, args: string[]) {
  let output = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true })
  try {
    const code = await main(['--project', stores.projectDir, '--json', ...args])
    return { code, data: JSON.parse(output) }
  } finally { stdout.mockRestore() }
}

it('quality verify/repair 校验、恢复与拒绝篡改，命令支持单个 JSON 和退出码', async () => {
  const stores = await fixture()
  expect(await cli(stores, ['quality', 'verify'])).toEqual({ code: 0, data: { ok: true } })
  await stores.quality!.append([{ type: 'observation.recorded', actor: { type: 'system', id: 'test' }, data: {
    id: 'review:run-1:1:0', source: 'review', kind: 'found', requirementId: 'REQ-1', subject: {}, text: '问题', evidence: [], at: new Date().toISOString(),
  } }], { idempotencyKeys: ['review:run-1:1:0'] })
  await rm(join(stores.taktDir, 'quality/chain.json'))
  expect(await cli(stores, ['quality', 'verify'])).toMatchObject({ code: 1, data: { ok: false, reason: 'incomplete' } })
  expect(await cli(stores, ['quality', 'repair'])).toMatchObject({ code: 0, data: { ok: true, appended: 1 } })
  expect((await stores.quality!.read({ types: ['log.recovered'] }))).toHaveLength(1)
  expect(await cli(stores, ['quality', 'defects'])).toEqual({ code: 0, data: [] })
  const file = join(stores.taktDir, 'quality/log.jsonl')
  const corrupted = (await readFile(file, 'utf8')).replace('问题', '篡改')
  await writeFile(file, corrupted)
  expect(await cli(stores, ['quality', 'repair'])).toMatchObject({ code: 1, data: { error: expect.stringContaining('tampered') } })
  expect(await readFile(file, 'utf8')).toBe(corrupted)
})

it('quality sync --run 校验运行与租约；坏 workflow 不影响质量命令', async () => {
  const stores = await fixture()
  await writeFile(join(stores.paths.workflows, 'broken.workflow.ts'), 'invalid workflow')
  const run: RunState = { runId: 'run-1', workflowId: 'wf', workflowVersion: '1', requirementId: 'REQ-1', nodes: {}, args: {}, expansions: [], status: 'succeeded', startedAt: new Date().toISOString() }
  await stores.runs.create(run, { id: 'wf', title: 'wf', version: '1', stages: [], nodes: [] })
  await stores.events.append(run.runId, { type: 'run.finished', actor: { type: 'system', id: 'test' }, data: { status: 'succeeded' } })
  expect(await cli(stores, ['quality', 'sync', '--run', run.runId])).toEqual({ code: 0, data: [{ runId: 'run-1', seq: 1, observations: 0 }] })
  expect(await cli(stores, ['quality', 'sync', '--run', 'missing'])).toMatchObject({ code: 1, data: { error: expect.stringContaining('不存在') } })
  await acquireLease(stores.taktDir, 'other')
  try {
    expect(await cli(stores, ['quality', 'sync'])).toMatchObject({ code: 2, data: { error: expect.stringContaining('other') } })
    expect(await cli(stores, ['quality', 'repair'])).toMatchObject({ code: 2 })
    expect(await cli(stores, ['quality', 'verify'])).toMatchObject({ code: 0, data: { ok: true } })
  } finally { await releaseLease(stores.taktDir, 'other') }
})

async function reviewFixture(maxRounds: number) {
  const stores = await fixture()
  stores.config.workflows = []
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(stores.projectDir, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(stores.projectDir, 'node_modules'), 'dir')
  for (const role of ['author', 'reviewer']) await writeFile(join(stores.paths.agents, `${role}.md`), `---\nrole: ${role}\nharness: mock\nwriteScope: ["requirements/**"]\n---\n${role}`)
  await stores.workspaces.writeArtifact({ ref: { workspace: 'REQ-1', path: 'spec.md' }, content: '需求', kind: 'spec', author: { type: 'system', id: 'test' } })
  await writeFile(join(stores.paths.workflows, 'review.workflow.ts'), `import { defineWorkflow, review, human } from '@taktflow/core'
export default defineWorkflow({ id: 'review-wf', title: 'review', version: '1', stages: [], nodes: [
human({ id: 'start', title: '开始', ask: '开始评审', form: 'approve' }),
review({ id: 'review', title: '评审', needs: ['start'], target: ['spec.md'], author: { role: 'author' }, reviewers: [{ role: 'reviewer' }], maxRounds: ${maxRounds}, onExhausted: 'human' })] })`)
  await writeFile(join(stores.taktDir, 'mock.json'), JSON.stringify({ steps: [
    { match: { role: 'reviewer' }, structured: { verdict: 'request_changes', summary: '缺条件', issues: [{ id: 'one', severity: 'major', description: '缺少条件' }] } },
  ] }))
  return stores
}

it('run/resume 结束同步观察，answer --no-resume 即记录放行；后续 resume 不重复', async () => {
  const stores = await reviewFixture(1)
  const started = await cli(stores, ['run', 'review-wf', '--req', 'REQ-1', '--harness', 'mock'])
  expect(started.code, JSON.stringify(started.data)).toBe(0)
  expect(started.data.status).toBe('waiting_human')
  await cli(stores, ['answer', started.data.attention[0].requestId, '--approve', '--no-resume'])
  const reviewed = await cli(stores, ['resume', started.data.runId])
  expect(reviewed.code, JSON.stringify(reviewed.data)).toBe(0)
  expect(reviewed.data.status).toBe('waiting_human')
  expect((await stores.quality!.observations()).map((item) => item.kind)).toEqual(['found'])
  expect((await cli(stores, ['answer', reviewed.data.attention[0].requestId, '--choice', '放行', '--no-resume'])).code).toBe(0)
  expect((await stores.quality!.observations()).map((item) => item.kind)).toEqual(['found', 'overridden'])
  expect((await cli(stores, ['resume', started.data.runId])).data.status).toBe('succeeded')
  expect((await stores.quality!.observations()).map((item) => item.kind)).toEqual(['found', 'overridden'])
  const humanEvents = await stores.events.read(started.data.runId, { types: ['human.answered'] })
  expect(humanEvents).toHaveLength(2)
  expect(humanEvents.every((item) => item.actor.type === 'human' && item.actor.via === 'cli')).toBe(true)
}, 15000)

it('answer 默认 resume 的新增评审观察在返回前入账', async () => {
  const stores = await reviewFixture(1)
  const started = await cli(stores, ['run', 'review-wf', '--req', 'REQ-1', '--harness', 'mock'])
  expect(started.code, JSON.stringify(started.data)).toBe(0)
  const answered = await cli(stores, ['answer', started.data.attention[0].requestId, '--approve'])
  expect(answered.code, JSON.stringify(answered.data)).toBe(0)
  expect((await stores.quality!.observations()).map((item) => item.kind)).toEqual(['found'])
}, 15000)

it('run 本次产生的观察在返回前入账', async () => {
  const stores = await reviewFixture(1)
  const result = await cli(stores, ['run', 'review-wf', '--req', 'REQ-1', '--harness', 'mock', '--auto-approve'])
  expect(result.code, JSON.stringify(result.data)).toBe(0)
  expect((await stores.quality!.observations()).map((item) => item.kind)).toEqual(['found'])
}, 15000)

it('真实 serve 进程自动补算新增运行；退出释放租约，重启不重复观察', async () => {
  const stores = await fixture()
  stores.config.workflows = []
  await writeFile(join(stores.projectDir, 'takt.config.json'), JSON.stringify(stores.config))
  const start = async () => {
    let output = '', errors = ''
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import { runServe } from './packages/cli/src/commands/serve.ts'; await runServe({project:process.argv[1],port:0,json:true})", stores.projectDir], { cwd: repoRoot, stdio: 'pipe' })
    children.push(child)
    child.stdout!.on('data', (chunk) => { output += String(chunk) })
    child.stderr!.on('data', (chunk) => { errors += String(chunk) })
    await vi.waitFor(() => expect(output, errors).toContain('"url":'), { timeout: 6000 })
    return child
  }
  const stop = async (child: ChildProcess) => {
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
  }
  const child = await start()
  await stores.runs.create({ runId: 'serve-run', workflowId: 'wf', workflowVersion: '1', requirementId: 'REQ-1', status: 'running', startedAt: new Date().toISOString(), nodes: {}, expansions: [], args: {} }, {
    id: 'wf', title: 'wf', version: '1', stages: [], nodes: [{ id: 'review', kind: 'review', title: '评审', needs: [],
      review: { target: ['spec.md'], author: 'author', reviewers: [{ role: 'reviewer' }], pass: 'all', maxRounds: 1, onExhausted: 'human' } }],
  })
  const ref = { workspace: 'REQ-1', path: 'spec.md', version: 1 }
  const checkpointId = 'serve-run:review:1:1:reviewer'
  await stores.events.append('serve-run', { nodeId: 'review', type: 'checkpoint.scheduled', actor: { type: 'system', id: 'test' }, data: {
    checkpointId, runId: 'serve-run', nodeId: 'review', attempt: 1, round: 1, reviewer: 'reviewer', status: 'scheduled', materials: [{ ref, sha256: 'a'.repeat(64), role: 'target' }],
  } })
  await stores.events.append('serve-run', { nodeId: 'review', type: 'review.result', actor: { type: 'system', id: 'test' }, data: { checkpointId, references: [], record: {
    round: 1, reviewer: 'reviewer', verdict: 'request_changes', summary: '缺条件', issues: [{ id: 'one', key: 'ISS-1', severity: 'major', description: '缺条件' }], artifacts: [ref], at: new Date().toISOString(),
  } } })
  await vi.waitFor(async () => expect(await stores.quality!.observations()).toHaveLength(1), { timeout: 5000 })
  await stop(child)
  await expect(readFile(join(stores.taktDir, 'lease.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const log = await stores.quality!.read()
  const restarted = await start()
  await new Promise((resolve) => setTimeout(resolve, 400))
  await stop(restarted)
  expect(await stores.quality!.read()).toEqual(log)
}, 20000)
