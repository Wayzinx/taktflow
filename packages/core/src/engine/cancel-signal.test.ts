import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import sdlc from '../../../../templates/workflows/sdlc.workflow.js'
import example from '../../../../examples/hello-delivery/.takt/workflows/sdlc.workflow.js'
import { initProject } from '../store/project.js'
import type { NodeDef, ScriptNodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
function runCases(nodes: NodeDef[]): ScriptNodeDef {
  for (const node of nodes) {
    if (node.id === 'run-cases' && node.kind === 'script') return node
    if (node.kind === 'loop') {
      const child = node.body.find((entry) => entry.id === 'run-cases')
      if (child?.kind === 'script') return child
    }
  }
  throw new Error('模板没有 run-cases')
}

it.each(['function', 'template', 'example'] as const)('%s：NodeContext.signal 取消真实子进程，不吞 abort 或产生晚到产物', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'takt-cancel-signal-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '取消' })).id
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const program = "const fs=require('node:fs');fs.writeFileSync('started',String(process.pid));setTimeout(()=>fs.writeFileSync('late','unexpected'),700);setInterval(()=>{},1000)"
  const selected = kind === 'function' ? undefined : runCases((kind === 'template' ? sdlc : example).nodes)
  let signal: AbortSignal | undefined
  let caught: unknown
  const definition: WorkflowDefinition = { id: 'cancel', title: '', version: '1', stages: [], nodes: [{ id: 'run', title: '', kind: 'script', run: async (ctx) => {
    signal = ctx.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    try {
      if (selected) {
        if (typeof selected.run !== 'function') throw new Error('runCases 必须是函数')
        return await selected.run(ctx)
      }
      await promisify(execFile)(process.execPath, ['-e', program], { cwd: ctx.projectDir, signal: ctx.signal })
    } catch (error) { caught = error; throw error }
  } }] }
  const running = engine.start({ requirementId, workflow: definition, args: { caseCommand: `exec ${quote(process.execPath)} -e ${quote(program)}` } })
  void running.catch(() => undefined)
  let pid: number | undefined
  try {
    await vi.waitFor(async () => { pid = Number(await readFile(join(root, 'started'), 'utf8')); expect(pid).toBeGreaterThan(0) }, { timeout: 4000, interval: 10 })
    const run = (await stores.runs.list())[0]!
    await engine.cancel(run.runId)
    const state = await running
    expect(state.status).toBe('cancelled')
    expect(state.nodes.run?.status).toBe('cancelled')
    expect(signal?.aborted).toBe(true)
    expect(caught).toBeInstanceOf(Error)
    if (selected) expect(caught).toBe(signal?.reason)
    await vi.waitFor(() => { expect(() => process.kill(pid!, 0)).toThrow() }, { timeout: 1500, interval: 10 })
    await new Promise((resolve) => setTimeout(resolve, 750))
    await expect(access(join(root, 'late'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stores.events.read(run.runId, { types: ['node.finished'] })).toEqual([])
    expect(await stores.events.verify(run.runId)).toEqual({ ok: true })
  } finally {
    const run = (await stores.runs.list())[0]
    if (run) await engine.cancel(run.runId)
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出。 */ } }
    await running.catch(() => undefined)
  }
})

it('两份模板只允许 design knowledge 差异，runCases 都透传 signal', async () => {
  const template = await readFile(new URL('../../../../templates/workflows/sdlc.workflow.ts', import.meta.url), 'utf8')
  const exampleText = await readFile(new URL('../../../../examples/hello-delivery/.takt/workflows/sdlc.workflow.ts', import.meta.url), 'utf8')
  const designKnowledge = /^      knowledge: \[.*$/m
  expect(template.replace(designKnowledge, '')).toBe(exampleText.replace(designKnowledge, ''))
})
