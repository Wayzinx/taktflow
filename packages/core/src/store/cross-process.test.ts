import { spawn, execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import type { RunState, WorkflowSnapshot } from '../types.js'
import { FsAttentionStore } from './fs-attention.js'
import { FsEventStore } from './fs-events.js'
import { FsRunStore } from './fs-runs.js'
import { initProject } from './project.js'
import { markArtifactEdited } from './artifact-edits.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function temp() { const root = await mkdtemp(path.join(tmpdir(), 'takt-cross-')); roots.push(root); return root }
const execute = (script: string, ...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, ...args])

it('两个独立进程同时回答只有一个成功，answeredBy 保留获胜者', async () => {
  const dir = path.join(await temp(), '.takt')
  const store = new FsAttentionStore(dir)
  await store.create({ requestId: 'q', runId: 'r', nodeId: 'n', requirementId: 'REQ-1', ask: '?', form: 'approve' })
  const script = `import { FsAttentionStore } from ${JSON.stringify(new URL('./fs-attention.ts', import.meta.url).href)};
    const store = new FsAttentionStore(process.argv[1]);
    try { await store.answer('q', { decision: 'approve', by: { type: 'human', id: process.argv[2] } }); console.log('ok'); }
    catch(e) { console.log(e.name); }`
  const replies = await Promise.all([execute(script, dir, 'first'), execute(script, dir, 'second')])
  expect(replies.map((reply) => reply.stdout.trim()).sort()).toEqual(['AttentionAlreadyAnsweredError', 'ok'])
  const answered = (await store.list())[0]!
  expect(answered.answeredBy?.type).toBe('human')
  expect(answered).not.toHaveProperty('by')
})

it('多个独立进程追加日志仍保持 seq 连续和整链有效', async () => {
  const root = await temp()
  const dir = path.join(root, '.takt')
  const alias = path.join(await temp(), 'alias')
  await symlink(root, alias, 'dir')
  const script = `import { FsEventStore } from ${JSON.stringify(new URL('./fs-events.ts', import.meta.url).href)};
    const store = new FsEventStore(process.argv[1]);
    for(let i=0;i<12;i++) await store.append('r', { type:'log', actor:{type:'system',id:'child'}, data:{level:'info',message:String(i)} });`
  await Promise.all([execute(script, dir), execute(script, path.join(alias, '.takt')), execute(script, dir)])
  const store = new FsEventStore(dir)
  expect((await store.read('r')).map((e) => e.seq)).toEqual(Array.from({ length: 36 }, (_, i) => i + 1))
  expect(await store.verify('r')).toEqual({ ok: true })
})

it('子进程持有的旧快照不能覆盖人工修改；新尝试消费新版本后恢复且旧写不能复活', async () => {
  const root = await temp()
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: 'Test' })
  const ref = { workspace: 'REQ-1', path: 'spec/a.md' }
  const author = { type: 'human', id: 'reviewer' } as const
  await stores.workspaces.writeArtifact({ ref, content: 'v1', kind: 'spec', author, reason: 'create' })
  const state: RunState = { runId: 'r', workflowId: 'w', workflowVersion: '1', requirementId: 'REQ-1', status: 'running', startedAt: '', args: {}, expansions: [], nodes: {
    reader: { id: 'reader', status: 'running', attempts: 1, inputs: [{ ...ref, version: 1 }], outputs: [] },
    after: { id: 'after', status: 'succeeded', attempts: 1, outputs: [] },
    sibling: { id: 'sibling', status: 'succeeded', attempts: 1, outputs: [] },
  } }
  const snapshot: WorkflowSnapshot = { id: 'w', title: 'w', version: '1', stages: [], nodes: [
    { id: 'reader', title: 'reader', kind: 'script', needs: [] },
    { id: 'after', title: 'after', kind: 'script', needs: ['reader'] },
    { id: 'sibling', title: 'sibling', kind: 'script', needs: [] },
  ] }
  await stores.runs.create(state, snapshot)
  const script = `import { FsRunStore } from ${JSON.stringify(new URL('./fs-runs.ts', import.meta.url).href)};
    const store = new FsRunStore(process.argv[1]); const state = await store.get('r');
    console.log('ready');
    await new Promise(resolve => process.stdin.once('data', resolve));
    state.status='succeeded'; state.nodes.reader.status='succeeded'; state.nodes.reader.result='old';
    await store.save(state); console.log('saved');`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, stores.taktDir], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
      child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr)) })
    })
    const updated = await stores.workspaces.writeArtifact({ ref, content: 'v2', kind: 'spec', author, reason: 'edit' })
    expect(await markArtifactEdited(stores, updated, author, 'edit')).toEqual([{ runId: 'r', nodeId: 'reader' }, { runId: 'r', nodeId: 'after' }])
    child.stdin.end('continue')
    await exited
    const fresh = new FsRunStore(stores.taktDir)
    const readback = (await fresh.get('r'))!
    expect(readback.nodes.reader!.status).toBe('stale')
    expect(readback.nodes.after!.status).toBe('stale')
    expect(readback.nodes.sibling!.status).toBe('succeeded')
    expect(readback.status).not.toBe('succeeded')
    readback.nodes.reader!.status = 'pending'
    await fresh.save(readback)
    expect((await fresh.get('r'))!.nodes.reader!.status).toBe('stale')
    readback.nodes.reader!.status = 'running'
    readback.nodes.reader!.attempts++
    await fresh.save(readback)
    expect((await fresh.get('r'))!.nodes.reader!.status).toBe('running')
    readback.nodes.reader!.status = 'succeeded'
    await fresh.save(readback)
    expect((await fresh.get('r'))!.nodes.reader!.status).toBe('stale')
    readback.nodes.reader!.inputs = [updated]
    readback.nodes.after!.attempts++
    readback.nodes.after!.status = 'succeeded'
    readback.status = 'succeeded'
    readback.endedAt = '2026-11-04T23:00:00.000Z'
    await fresh.save(readback)
    expect((await fresh.get('r'))!.nodes.reader!.status).toBe('succeeded')
    expect((await fresh.get('r'))!.nodes.after!.status).toBe('succeeded')
    await fresh.save({ ...state, status: 'succeeded' })
    const preserved = (await fresh.get('r'))!
    expect(preserved.nodes.reader!.inputs).toEqual([updated])
    expect(preserved.status).toBe('succeeded')
    expect(preserved.endedAt).toBe('2026-11-04T23:00:00.000Z')
    await fresh.save({ ...state, status: 'cancelled' })
    expect((await fresh.get('r'))!.status).toBe('cancelled')
    expect(await stores.events.verify('r')).toEqual({ ok: true })
    expect((await stores.events.read('r')).map((e) => [e.type, e.actor])).toEqual([
      ['artifact.edited', author], ['node.stale', author], ['node.stale', author],
    ])
    expect(await stores.workspaces.detectUntracked('REQ-1')).toEqual([])
  } finally {
    if (child.exitCode === null) child.kill()
    await exited.catch(() => undefined)
  }
})
