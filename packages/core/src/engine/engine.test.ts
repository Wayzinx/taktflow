import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sdlc from '../../../../templates/workflows/sdlc.workflow.js'
import { agent, defineWorkflow, gate, human, judge, loop, planner, script } from '../dsl.js'
import { initProject, openProject } from '../store/project.js'
import type {
  Actor, AgentProfile, EventEnvelope, EventType, HarnessAdapter,
  HarnessEvent, HarnessRequest, HarnessResult, NodeDef, PlannedItem,
} from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
const tester: Actor = { type: 'human', id: 'engine-test' }
const jsonResult = (value: unknown): HarnessResult => ({
  ok: true, finalText: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class MemoryHarness implements HarnessAdapter {
  readonly id = 'mock'
  readonly displayName = '进程内验收 harness'
  readonly calls: HarnessRequest[] = []

  constructor(private readonly respond: (req: HarnessRequest) => Promise<HarnessResult> | HarnessResult) {}

  async available() { return { ok: true } }

  async run(req: HarnessRequest, onEvent: (event: HarnessEvent) => void): Promise<HarnessResult> {
    this.calls.push(req)
    onEvent({ type: 'started', sessionId: `memory-${this.calls.length}` })
    return this.respond(req)
  }
}

async function fixture(respond: ConstructorParameters<typeof MemoryHarness>[0] = () => {
  throw new Error('此场景不应调用 harness')
}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-basic-'))
  roots.push(root)
  const stores = await initProject(root, { layout: 'legacy' })
  const requirement = await stores.workspaces.createRequirement({ title: '引擎基本验收' })
  const harness = new MemoryHarness(respond)
  const profiles: Record<string, AgentProfile> = Object.fromEntries(
    ['dev', 'pm', 'architect', 'judge', 'automation', 'test-designer', 'reviewer'].map((role) => [role, {
      role, title: role, description: '', instructions: `完成 ${role} 的任务`,
      harness: { harness: 'mock' }, skills: [], writeScope: ['**'],
    }]),
  )
  const deps = { stores, profiles, harnesses: { mock: harness }, knowledge: [] }
  return { root, stores, requirementId: requirement.id, harness, deps }
}

function workflow(nodes: NodeDef[]) {
  return defineWorkflow({ id: 'basic', title: '基本验收', version: '1', stages: [], nodes })
}

async function writeText(root: string, relative: string, content: string) {
  const file = join(root, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

function workspaceOf(req: HarnessRequest): string {
  const workspace = req.env?.TAKT_WORKSPACE
  if (!workspace) throw new Error('harness 缺少 TAKT_WORKSPACE')
  return workspace
}

function eventsOf<T extends EventType>(events: EventEnvelope[], type: T, nodeId?: string): EventEnvelope<T>[] {
  return events.filter((event) => event.type === type && (nodeId === undefined || event.nodeId === nodeId)) as EventEnvelope<T>[]
}

function sequence(events: EventEnvelope[], type: EventType, nodeId?: string): number {
  const matches = eventsOf(events, type, nodeId)
  expect(matches, `${nodeId ?? 'run'} 的 ${type} 事件`).toHaveLength(1)
  return matches[0]!.seq
}

describe('core-engine：简报六类基本验收', () => {
  it('线性 script → agent → gate：生命周期有序、审计链有效、产物版本可溯源', async () => {
    const { root, stores, requirementId, harness, deps } = await fixture(async (req) => {
      const input = await readFile(join(workspaceOf(req), 'inputs/source.md'), 'utf8')
      await writeText(workspaceOf(req), 'spec/spec.md', `AC-1: ${input}`)
      return jsonResult({ written: true })
    })
    const ref = { workspace: requirementId, path: 'inputs/source.md' }
    await stores.workspaces.writeArtifact({ ref, content: '旧物料', kind: 'input', author: tester, reason: '建立旧版本' })
    const def = workflow([
      script({
        id: 'prepare', title: '更新物料', outputs: [{ path: ref.path, kind: 'input' }],
        run: async (ctx) => {
          await writeText(ctx.workspaceDir, ref.path, '新物料')
          return { data: { ready: true } }
        },
      }),
      agent({
        id: 'draft', title: '编写规格', role: 'dev', needs: ['prepare'],
        inputs: [{ path: ref.path }], outputs: [{ path: 'spec/spec.md', kind: 'spec' }],
        writeScope: ['.takt/workspaces/**/spec/**'], prompt: '根据输入写 AC-1',
        resultSchema: { type: 'object', required: ['written'], properties: { written: { type: 'boolean' } } },
      }),
      gate({
        id: 'verify', title: '检查规格', needs: ['draft'], checks: [{
          id: 'content', kind: 'function', fn: async (ctx) => ({
            id: 'content', pass: (await ctx.readArtifact('spec/spec.md')) === 'AC-1: 新物料'
              && (ctx.resultOf('draft') as { written: boolean }).written,
          }),
        }],
      }),
    ])
    const state = await createEngine(deps).start({ workflow: def, requirementId })
    expect(state.status).toBe('succeeded')
    expect(Object.values(state.nodes).map((node) => node.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toMatchObject({ cwd: root, env: { TAKT_RUN_ID: state.runId, TAKT_NODE: 'draft', TAKT_ROLE: 'dev' } })

    const reopened = await openProject(root)
    expect(await reopened.runs.get(state.runId)).toEqual(state)
    expect(await reopened.runs.getWorkflow(state.runId)).toMatchObject({ id: def.id, version: def.version })
    const sourceV2 = { ...ref, version: 2 }
    const outputRef = { workspace: requirementId, path: 'spec/spec.md', version: 1 }
    expect(state.nodes.prepare?.outputs).toEqual([sourceV2])
    expect(state.nodes.draft?.inputs).toEqual([sourceV2])
    expect(state.nodes.draft?.outputs).toEqual([outputRef])
    expect((await reopened.workspaces.readArtifact({ ...ref, version: 1 }))?.toString()).toBe('旧物料')
    expect((await reopened.workspaces.readArtifact(sourceV2))?.toString()).toBe('新物料')
    expect((await reopened.workspaces.readArtifact(outputRef))?.toString()).toBe('AC-1: 新物料')
    const records = await reopened.workspaces.listArtifacts(requirementId)
    expect(records.find((record) => record.path === ref.path)?.versions).toHaveLength(2)
    const version = records.find((record) => record.path === outputRef.path)?.versions[0]
    expect(version).toMatchObject({ version: 1, derivedFrom: [sourceV2], producedBy: { runId: state.runId, nodeId: 'draft' } })
    expect(version?.sha256).toMatch(/^[a-f0-9]{64}$/)

    const events = await reopened.events.read(state.runId)
    let previous = sequence(events, 'run.started')
    for (const id of ['prepare', 'draft', 'verify']) {
      const ready = sequence(events, 'node.ready', id)
      const started = sequence(events, 'node.started', id)
      const finished = sequence(events, 'node.finished', id)
      expect(ready).toBeGreaterThan(previous)
      expect(started).toBeGreaterThan(ready)
      expect(finished).toBeGreaterThan(started)
      previous = finished
    }
    expect(sequence(events, 'run.finished')).toBeGreaterThan(previous)
    expect(eventsOf(events, 'run.finished')[0]?.data).toEqual({ status: 'succeeded' })
    expect(eventsOf(events, 'artifact.written', 'draft')[0]?.data).toMatchObject({ ref: outputRef, sha256: version?.sha256 })
    expect(eventsOf(events, 'gate.result', 'verify')[0]?.data).toMatchObject({ pass: true, checks: [{ id: 'content', pass: true }] })
    expect(eventsOf(events, 'node.failed')).toEqual([])
    expect(eventsOf(events, 'guard.violation')).toEqual([])
    expect(await reopened.events.verify(state.runId)).toEqual({ ok: true })
  })

  it('human answer：暂停、回答、换实例 resume，已完成节点不重跑', async () => {
    const { root, stores, requirementId, deps } = await fixture()
    let prepared = 0
    const answers: unknown[] = []
    const def = workflow([
      script({ id: 'prepare', title: '准备', run: async () => { prepared++ } }),
      human({ id: 'answer', title: '澄清', needs: ['prepare'], form: 'answer', ask: '验收范围是什么？' }),
      script({ id: 'consume', title: '使用回答', needs: ['answer'], run: async (ctx) => { answers.push(ctx.resultOf('answer')) } }),
    ])
    const paused = await createEngine(deps).start({ workflow: def, requirementId })
    expect(paused.status).toBe('waiting_human')
    expect(paused.nodes.answer?.status).toBe('waiting_human')
    expect(paused.nodes.consume?.status).toBe('pending')
    expect(answers).toEqual([])
    expect(await stores.runs.get(paused.runId)).toEqual(paused)
    const pending = await stores.attention.list({ pending: true })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ requestId: `${paused.runId}:answer`, nodeId: 'answer', form: 'answer' })
    await stores.attention.answer(pending[0]!.requestId, { decision: 'answer', answer: '只验收 AC-1', by: tester })
    const reopened = await openProject(root)
    const completed = await createEngine({ ...deps, stores: reopened }).resume(paused.runId, def)
    expect(completed.status).toBe('succeeded')
    expect(completed.nodes.answer?.result).toEqual({ decision: 'answer', answer: '只验收 AC-1' })
    expect(answers).toEqual([{ decision: 'answer', answer: '只验收 AC-1' }])
    expect(prepared).toBe(1)
    expect(await reopened.runs.get(paused.runId)).toEqual(completed)
    expect(await reopened.attention.list({ pending: true })).toEqual([])
    const events = await reopened.events.read(paused.runId)
    expect(eventsOf(events, 'human.requested', 'answer')).toHaveLength(1)
    expect(eventsOf(events, 'human.answered', 'answer')).toHaveLength(1)
    expect(eventsOf(events, 'human.answered', 'answer')[0]?.data).toMatchObject({ answer: '只验收 AC-1' })
    expect(eventsOf(events, 'node.started', 'prepare')).toHaveLength(1)
    expect(await reopened.events.verify(paused.runId)).toEqual({ ok: true })
  })

  it.each([true, false])('人工节点：别的分支还在跑时回答，通知=%s 都不会停在 waiting_human；通知了下游立刻接着跑', async (notify) => {
    const { stores, requirementId, deps } = await fixture()
    let release!: () => void
    const slow = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const engine = createEngine(deps)
    const running = engine.start({ requirementId, workflow: workflow([
      script({ id: 'slow', title: '长分支', run: async () => { await slow; order.push('slow') } }),
      human({ id: 'gate', title: '确认', form: 'approve', ask: '放行？' }),
      script({ id: 'after', title: '确认后', needs: ['gate'], run: async () => { order.push('after') } }),
    ]) })
    const wait = async (ready: () => Promise<boolean> | boolean) => { for (let i = 0; i < 400 && !await ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5)) }
    let item: Awaited<ReturnType<typeof stores.attention.list>>[number] | undefined
    await wait(async () => Boolean(item = (await stores.attention.list({ pending: true }))[0]))
    await stores.attention.answer(item!.requestId, { decision: 'approve', by: tester })
    if (notify) {
      expect(engine.notifyAnswered!(item!.runId)).toBe(true)
      await wait(() => order.includes('after'))
      expect(order).toEqual(['after'])
    }
    release()
    const state = await running
    expect(state.status).toBe('succeeded')
    expect(order).toEqual(notify ? ['after', 'slow'] : ['slow', 'after'])
    expect(engine.notifyAnswered!(state.runId)).toBe(false)
  })

  it('loop + judge：首轮 product_bug 只修代码，第二轮无失败，未命中的路由 skipped', async () => {
    const verdict = { subject: 'TC-1', category: 'product_bug', confidence: 0.99, rationale: '返回值违反 AC-1', evidence: ['evidence/TC-1.txt'] }
    const { stores, requirementId, harness, deps } = await fixture((req) => {
      if (req.env?.TAKT_ROLE === 'judge') return jsonResult({ verdicts: [verdict] })
      if (req.env?.TAKT_NODE === 'cycle/fix-code') return { ok: true, finalText: '已修复产品代码' }
      throw new Error(`不应运行的修复节点：${req.env?.TAKT_NODE}`)
    })
    const iterations: Array<number | undefined> = []
    const observed: Array<{ iteration: number | undefined; result: unknown }> = []
    const def = workflow([loop({
      id: 'cycle', title: '研发测试', maxIterations: 2, onExhausted: 'fail',
      until: (ctx) => {
        observed.push({ iteration: ctx.iteration, result: ctx.resultOf('judge') })
        return (ctx.resultOf('run') as { failures: unknown[] }).failures.length === 0
      },
      body: [
        script({ id: 'run', title: '执行', run: async (ctx) => {
          iterations.push(ctx.iteration)
          return { data: { failures: ctx.iteration === 1 ? [{ subject: 'TC-1' }] : [] } }
        } }),
        judge({ id: 'judge', title: '判决', role: 'judge', needs: ['run'], target: 'run', routes: {
          product_bug: 'fix-code', script_defect: 'fix-script', case_defect: 'fix-case',
        } }),
        agent({ id: 'fix-code', title: '修代码', role: 'dev', needs: ['judge'], prompt: '修复产品缺陷' }),
        agent({ id: 'fix-script', title: '修脚本', role: 'automation', needs: ['judge'], prompt: '修复脚本' }),
        agent({ id: 'fix-case', title: '修用例', role: 'test-designer', needs: ['judge'], prompt: '修正用例' }),
      ],
    })])
    const state = await createEngine(deps).start({ workflow: def, requirementId })
    expect(state.status).toBe('succeeded')
    expect(iterations).toEqual([1, 2])
    expect(observed).toEqual([
      { iteration: 1, result: { verdicts: [verdict], routed: { 'fix-code': ['TC-1'] } } },
      { iteration: 2, result: { verdicts: [], routed: {} } },
    ])
    expect(harness.calls.map((req) => req.env?.TAKT_NODE)).toEqual(['cycle/judge', 'cycle/fix-code'])
    expect(state.nodes.cycle?.status).toBe('succeeded')
    expect(state.nodes['cycle/run']).toMatchObject({ iteration: 2, result: { failures: [] } })
    for (const id of ['fix-code', 'fix-script', 'fix-case']) expect(state.nodes[`cycle/${id}`]?.status).toBe('skipped')
    const events = await stores.events.read(state.runId)
    const runStarts = eventsOf(events, 'node.started', 'cycle/run')
    expect(runStarts.map((event) => event.data.iteration)).toEqual([1, 2])
    const fixFinishes = eventsOf(events, 'node.finished', 'cycle/fix-code')
    expect(fixFinishes.map((event) => event.data.status)).toEqual(['succeeded', 'skipped'])
    expect(fixFinishes[0]!.seq).toBeLessThan(runStarts[1]!.seq)
    for (const id of ['fix-script', 'fix-case']) {
      expect(eventsOf(events, 'node.started', `cycle/${id}`)).toEqual([])
      expect(eventsOf(events, 'node.finished', `cycle/${id}`).map((event) => event.data.status)).toEqual(['skipped', 'skipped'])
    }
    expect(eventsOf(events, 'judge.verdict', 'cycle/judge')[0]?.data).toMatchObject({
      verdicts: [verdict], routed: [{ subject: 'TC-1', to: 'fix-code' }],
    })
    expect(await stores.runs.get(state.runId)).toEqual(state)
    expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
  })

  it('planner：逆序给出三个有依赖的条目，展开六节点并按依赖执行', async () => {
    // 故意把依赖项放在后面，避免数组顺序恰好掩盖丢失的跨条目依赖。
    const items: PlannedItem[] = [
      { key: 'c', title: 'C', role: 'dev', dependsOn: ['b'] },
      { key: 'b', title: 'B', role: 'dev', dependsOn: ['a'] },
      { key: 'a', title: 'A', role: 'dev' },
    ]
    const { stores, requirementId, harness, deps } = await fixture(() => jsonResult({ items }))
    const calls: string[] = []
    const def = workflow([
      planner({
        id: 'plan', title: '拆任务', role: 'architect', prompt: '拆成三个条目', maxItems: 3, allowedRoles: ['dev'],
        expand: (item) => [
          script({ id: 'code', title: '实现', run: async (ctx) => {
            expect(ctx.item).toEqual(item)
            calls.push(ctx.nodeId)
            return { data: { key: item.key } }
          } }),
          script({ id: 'check', title: '验证', needs: ['code'], run: async (ctx) => {
            expect(ctx.resultOf('code')).toEqual({ key: item.key })
            calls.push(ctx.nodeId)
          } }),
        ],
      }),
      script({ id: 'after', title: '汇总', needs: ['plan'], run: async () => { calls.push('after') } }),
    ])
    const state = await createEngine(deps, { concurrency: 4 }).start({ workflow: def, requirementId })
    const expectedIds = ['a', 'b', 'c'].flatMap((key) => [`plan/${key}/code`, `plan/${key}/check`])
    expect(state.status).toBe('succeeded')
    expect(calls).toEqual([...expectedIds, 'after'])
    expect(harness.calls).toHaveLength(1)
    expect(state.expansions).toHaveLength(1)
    expect(state.expansions[0]).toMatchObject({ plannerId: 'plan', items })
    expect(state.expansions[0]!.nodeIds.slice().sort()).toEqual(expectedIds.slice().sort())
    expect(Object.keys(state.nodes).filter((id) => id.startsWith('plan/')).sort()).toEqual(expectedIds.slice().sort())
    for (const id of ['plan', ...expectedIds, 'after']) expect(state.nodes[id]?.status).toBe('succeeded')
    const events = await stores.events.read(state.runId)
    expect(eventsOf(events, 'dag.expanded')).toHaveLength(1)
    expect(eventsOf(events, 'dag.expanded')[0]?.data).toEqual(state.expansions[0])
    for (let index = 1; index < expectedIds.length; index++) {
      expect(sequence(events, 'node.started', expectedIds[index])).toBeGreaterThan(sequence(events, 'node.finished', expectedIds[index - 1]))
    }
    expect(sequence(events, 'node.finished', 'plan')).toBeGreaterThan(sequence(events, 'node.finished', 'plan/c/check'))
    expect(sequence(events, 'node.started', 'after')).toBeGreaterThan(sequence(events, 'node.finished', 'plan'))
    expect(await stores.runs.get(state.runId)).toEqual(state)
    expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
  })

  it('planner：条目 params.paths 超出改代码节点的写权限时整体失败，不展开、不等实现被守卫拦', async () => {
    const items = [{ key: 'game', title: '小游戏', role: 'dev', params: { repo: 'app', paths: ['games/tank/logic.js', 'src/ok.ts'] } }]
    const { requirementId, harness, deps } = await fixture(() => jsonResult({ items }))
    deps.profiles.dev = { ...deps.profiles.dev!, writeScope: ['src/**'] }
    const state = await createEngine(deps).start({ requirementId, workflow: workflow([
      planner({ id: 'plan', title: '规划', role: 'architect', prompt: '规划', maxItems: 3, allowedRoles: ['dev'], expand: () => [agent({ id: 'code', title: '实现', role: 'dev', repo: 'app', prompt: '实现' })] }),
    ]) })
    expect(state.nodes.plan?.status).toBe('failed')
    expect(state.nodes.plan?.error).toContain('game 要改 games/tank/logic.js，角色 dev 只能写 src/**')
    expect(state.nodes.plan?.error).not.toContain('src/ok.ts')
    expect(state.expansions).toEqual([])
    expect(harness.calls).toHaveLength(1)
  })

  it('planner：超过 maxItems 整体失败，不截断展开，下游保持 pending', async () => {
    const items = ['a', 'b', 'c', 'd'].map((key) => ({ key, title: key, role: 'dev' }))
    const { stores, requirementId, harness, deps } = await fixture(() => jsonResult({ items }))
    let expansions = 0
    let executions = 0
    const state = await createEngine(deps).start({ requirementId, workflow: workflow([
      planner({ id: 'plan', title: '超限规划', role: 'architect', prompt: '规划', maxItems: 3, allowedRoles: ['dev'], expand: () => {
        expansions++
        return [script({ id: 'child', title: '子任务', run: async () => { executions++ } })]
      } }),
      script({ id: 'after', title: '下游', needs: ['plan'], run: async () => { executions++ } }),
    ]) })
    expect(state.status).toBe('failed')
    expect(state.nodes.plan?.status).toBe('failed')
    expect(state.nodes.plan?.error).toMatch(/maxItems|上限|超[过限]|too many|limit/i)
    expect(state.nodes.after?.status).toBe('pending')
    expect(state.expansions).toEqual([])
    expect(Object.keys(state.nodes).sort()).toEqual(['after', 'plan'])
    expect(expansions).toBe(0)
    expect(executions).toBe(0)
    expect(harness.calls).toHaveLength(1)
    const events = await stores.events.read(state.runId)
    expect(eventsOf(events, 'dag.expanded')).toEqual([])
    expect(eventsOf(events, 'node.failed', 'plan')).toHaveLength(1)
    expect(eventsOf(events, 'run.finished')[0]?.data).toEqual({ status: 'failed' })
    expect(await stores.runs.get(state.runId)).toEqual(state)
  })

  it('guard：非 git 项目越界写入记 flagged，节点 blocked，后续不能运行', async () => {
    const { root, stores, requirementId, deps } = await fixture(async (req) => {
      await writeText(req.cwd, 'src/allowed/ok.txt', '合法写入')
      await writeText(req.cwd, 'src/outside.txt', '越界写入')
      return { ok: true, finalText: '写入完成' }
    })
    deps.profiles.dev!.writeScope = ['src/**']
    let downstream = 0
    const state = await createEngine(deps).start({ requirementId, workflow: workflow([
      agent({ id: 'writer', title: '写文件', role: 'dev', writeScope: ['src/allowed/**'], prompt: '只写授权目录' }),
      script({ id: 'after', title: '下游', needs: ['writer'], run: async () => { downstream++ } }),
    ]) })
    expect(state.status).not.toBe('succeeded')
    expect(state.nodes.writer?.status).toBe('blocked')
    expect(state.nodes.after?.status).toBe('pending')
    expect(downstream).toBe(0)
    const violations = eventsOf(await stores.events.read(state.runId), 'guard.violation', 'writer')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.data).toMatchObject({ paths: ['src/outside.txt'], action: 'flagged' })
    expect(await readFile(join(root, 'src/allowed/ok.txt'), 'utf8')).toBe('合法写入')
    expect(await readFile(join(root, 'src/outside.txt'), 'utf8')).toBe('越界写入')
    expect((await stores.runs.get(state.runId))?.nodes.writer?.status).toBe('blocked')
  })

  it('真实 SDLC 模板：停 answer-clarify，回答后 resume 停 review-spec', async () => {
    const { root, stores, requirementId, harness, deps } = await fixture(async (req) => {
      switch (req.env?.TAKT_NODE) {
        case 'clarify':
          await writeText(workspaceOf(req), 'spec/clarify.md', '请确认 AC-1 的范围。')
          break
        case 'spec':
          await writeText(workspaceOf(req), 'spec/spec.md', '# 规格\nAC-1: 输入有效需求后生成规格。')
          break
        default:
          throw new Error(`人工评审前不应运行 ${req.env?.TAKT_NODE}`)
      }
      return { ok: true, finalText: '产物已写入' }
    })
    const inputRef = await stores.workspaces.writeArtifact({
      ref: { workspace: requirementId, path: 'inputs/prd.md' }, content: '根据有效需求生成规格。', kind: 'input', author: tester, reason: '验收物料',
    })
    const paused = await createEngine(deps).start({ workflow: sdlc, requirementId })
    expect(paused.status).toBe('waiting_human')
    expect(paused.nodes.clarify?.status).toBe('succeeded')
    expect(paused.nodes['answer-clarify']?.status).toBe('waiting_human')
    expect(paused.nodes.spec?.status).toBe('pending')
    expect(harness.calls.map((req) => req.env?.TAKT_NODE)).toEqual(['clarify'])
    const firstPending = await stores.attention.list({ pending: true })
    expect(firstPending).toHaveLength(1)
    expect(firstPending[0]).toMatchObject({ nodeId: 'answer-clarify', form: 'answer' })
    expect(await stores.runs.get(paused.runId)).toEqual(paused)
    await stores.attention.answer(firstPending[0]!.requestId, { decision: 'answer', answer: '确认 AC-1 范围。', by: tester })

    const reopened = await openProject(root)
    const resumed = await createEngine({ ...deps, stores: reopened }).resume(paused.runId, sdlc)
    expect(resumed.status).toBe('waiting_human')
    expect(resumed.nodes['answer-clarify']).toMatchObject({ status: 'succeeded', result: { decision: 'answer', answer: '确认 AC-1 范围。' } })
    expect(resumed.nodes.spec?.status).toBe('succeeded')
    expect(resumed.nodes['review-spec']?.status).toBe('waiting_human')
    expect(harness.calls.map((req) => req.env?.TAKT_NODE)).toEqual(['clarify', 'spec'])
    for (const node of sdlc.nodes.filter((node) => !['clarify', 'answer-clarify', 'spec', 'review-spec'].includes(node.id))) {
      expect(resumed.nodes[node.id]?.status, node.id).toBe('pending')
    }
    const secondPending = await reopened.attention.list({ pending: true })
    expect(secondPending).toHaveLength(1)
    expect(secondPending[0]).toMatchObject({ nodeId: 'review-spec', form: 'approve' })
    expect(await reopened.runs.get(paused.runId)).toEqual(resumed)
    const clarifyRef = { workspace: requirementId, path: 'spec/clarify.md', version: 1 }
    expect(resumed.nodes.clarify?.inputs).toEqual([inputRef])
    expect(resumed.nodes.spec?.inputs).toEqual(expect.arrayContaining([inputRef, clarifyRef]))
    const records = await reopened.workspaces.listArtifacts(requirementId)
    for (const [file, nodeId] of [['spec/clarify.md', 'clarify'], ['spec/spec.md', 'spec']] as const) {
      const versions = records.find((record) => record.path === file)?.versions
      expect(versions).toHaveLength(1)
      expect(versions?.[0]?.producedBy).toEqual({ runId: paused.runId, nodeId, invocationId: expect.any(String) })
    }
    const events = await reopened.events.read(paused.runId)
    expect(eventsOf(events, 'human.requested').map((event) => event.nodeId)).toEqual(['answer-clarify', 'review-spec'])
    expect(eventsOf(events, 'human.answered', 'answer-clarify')).toHaveLength(1)
    expect(eventsOf(events, 'node.started', 'clarify')).toHaveLength(1)
    expect(eventsOf(events, 'node.failed')).toEqual([])
    expect(eventsOf(events, 'guard.violation')).toEqual([])
    expect(await reopened.events.verify(paused.runId)).toEqual({ ok: true })
  })
})
