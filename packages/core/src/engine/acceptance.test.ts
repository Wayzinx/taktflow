/**
 * 独立边界验收测试（黑盒）：只使用公共协议（Engine / RunState / 事件 / 存储 / DSL），
 * 不假设引擎内部 helper；所有被测项目都建在 os.tmpdir()，harness 是进程内最小实现。
 *
 * 覆盖开发简报 6 条基本场景之外的独立边界：
 * 1. 嵌套 planner/loop + concurrency=1 不死锁；容器内 human 暂停后换引擎实例 resume，成功节点与规划次数保留；
 * 2. cancel 触发真实 AbortSignal、磁盘终态 cancelled、依赖节点不运行；
 * 3. 并发写守卫：交错写合法文件不误报；节点 ∩ 角色写权限仍拦越界；
 * 4. markStale 沿动态 planner 子节点 → planner 父 → 下游传播，未读该产物的兄弟节点不受影响；
 * 5. planner 重复 key / 依赖环 / 非法角色一律 fail-closed；
 * 6. harnessOverride 强制 agent / judge / rubric / planner 全部走覆盖 harness。
 *
 * 运行前提：packages/core/src/engine/index.ts 已提供 createEngine。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agent, defineWorkflow, gate, human, judge, loop, planner, script } from '../dsl.js'
import type { EngineDeps, ProjectStores } from '../interfaces.js'
import { initProject, openProject } from '../store/project.js'
import type {
  Actor,
  AgentProfile,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessRequest,
  HarnessResult,
  PlannedItem,
  WorkflowDefinition,
} from '../types.js'
import { createEngine } from './index.js'

const TEST_TIMEOUT = 30_000

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempProject(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `takt-acceptance-${label}-`))
  roots.push(root)
  return root
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 给等待加明确上限：超时信息要直接指出疑似死锁/未响应的位置。 */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`等待超时（${ms}ms）：${label}`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 引擎 start 会先把 RunState 落盘再调度，所以可以从磁盘拿到 runId 后调 cancel。 */
async function pollRunId(stores: ProjectStores, requirementId: string): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const [run] = await stores.runs.list({ requirementId })
    if (run !== undefined) return run.runId
    if (Date.now() > deadline) throw new Error(`运行未在 10s 内落盘：${requirementId}`)
    await sleep(20)
  }
}

const jsonFence = (value: unknown): string => ['```json', JSON.stringify(value), '```'].join('\n')

/** 既给 finalText 里的 json fence，也给 structured，覆盖两种公共解析路径。 */
function structuredOk(value: unknown): HarnessResult {
  return { ok: true, finalText: jsonFence(value), structured: value }
}

const textOk = (text: string): HarnessResult => ({ ok: true, finalText: text })

type HarnessScript = (req: HarnessRequest, onEvent: (e: HarnessEvent) => void) => Promise<HarnessResult> | HarnessResult

/** 进程内最小 HarnessAdapter：记录调用，行为由脚本决定；不依赖 @taktflow/harness。 */
class TestHarness implements HarnessAdapter {
  readonly id: string
  readonly displayName: string
  readonly capabilities: HarnessCapabilities = { resume: true, structuredOutput: true, toolEvents: true, usage: true }
  readonly calls: HarnessRequest[] = []
  private readonly script: HarnessScript

  constructor(id: string, script: HarnessScript) {
    this.id = id
    this.displayName = id
    this.script = script
  }

  async available(): Promise<{ ok: true }> {
    return { ok: true }
  }

  async run(req: HarnessRequest, onEvent: (e: HarnessEvent) => void): Promise<HarnessResult> {
    this.calls.push(req)
    return await this.script(req, onEvent)
  }
}

function profileOf(role: string, harness: string, writeScope: string[] = ['**']): AgentProfile {
  return { role, title: role, description: '', harness: { harness }, skills: [], writeScope, instructions: `你是 ${role}。` }
}

function depsOf(
  stores: ProjectStores,
  harnesses: Record<string, HarnessAdapter>,
  profiles: Record<string, AgentProfile>,
): EngineDeps {
  return { stores, harnesses, profiles, knowledge: [] }
}

/** agent 产物必须写进公共存放区，引擎才能按 outputs 收集到版本。 */
async function writeWorkspaceFile(env: Record<string, string> | undefined, relative: string): Promise<void> {
  const workspace = env?.TAKT_WORKSPACE
  if (workspace === undefined) throw new Error('harness 未收到 TAKT_WORKSPACE')
  const file = path.join(workspace, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, relative)
}

const humanActor: Actor = { type: 'human', id: 'tester' }

// ------------------------------------------------------------------ 1. 嵌套容器 + resume

describe('边界 1：嵌套 planner/loop + concurrency=1 + 容器内 human + 换实例 resume', () => {
  it(
    'concurrency=1 下 planner 展开 loop 不死锁；容器内 human 暂停后新引擎实例 resume，成功节点与规划调用次数保留',
    async () => {
      const root = await tempProject('nested')
      const stores = await initProject(root, { name: '嵌套容器' })
      const requirement = await stores.workspaces.createRequirement({ title: '嵌套容器' })

      let checkRuns = 0
      const calls = { plan: 0, draft: 0 }
      const harness = new TestHarness('mock', (req) => {
        const text = req.prompt
        if (text.includes('PLAN:')) {
          calls.plan += 1
          return structuredOk({ items: [{ key: 't1', title: '任务一', role: 'dev' }] })
        }
        if (text.includes('NODE:draft')) {
          calls.draft += 1
          return textOk('草稿完成')
        }
        throw new Error(`未预期的 harness 调用：${text.slice(0, 120)}`)
      })

      const workflow: WorkflowDefinition = defineWorkflow({
        id: 'nested', title: '嵌套容器', version: '1', stages: [{ id: 's', title: '阶段' }],
        nodes: [
          planner({
            id: 'split', title: '拆任务', role: 'architect', prompt: 'PLAN: 拆任务', maxItems: 3, allowedRoles: ['dev'],
            expand: () => [
              agent({ id: 'draft', title: '起草', role: 'dev', prompt: 'NODE:draft' }),
              loop({
                id: 'check-loop', title: '检查循环', needs: ['draft'], maxIterations: 2, until: () => true,
                body: [
                  script({
                    id: 'check', title: '检查',
                    run: async () => {
                      checkRuns += 1
                      return { data: { pass: true } }
                    },
                  }),
                  human({ id: 'approve', title: '人工确认', needs: ['check'], form: 'approve', ask: '检查通过吗？' }),
                ],
              }),
            ],
          }),
        ],
      })

      const profiles = { architect: profileOf('architect', 'mock'), dev: profileOf('dev', 'mock') }
      const engine = createEngine(depsOf(stores, { mock: harness }, profiles), { concurrency: 1 })

      const startPromise = engine.start({ workflow, requirementId: requirement.id })
      void startPromise.catch(() => undefined)
      const paused = await withDeadline(startPromise, 15_000, 'start 未返回（concurrency=1 下嵌套容器疑似死锁）')

      expect(paused.status).toBe('waiting_human')
      expect(calls.plan).toBe(1)
      expect(calls.draft).toBe(1)
      expect(checkRuns).toBe(1)
      expect(paused.expansions).toHaveLength(1)
      expect(paused.expansions[0]?.plannerId).toBe('split')
      expect(paused.expansions[0]?.items.map((item) => item.key)).toEqual(['t1'])

      expect(paused.nodes['split/t1/check-loop/approve']?.status).toBe('waiting_human')

      const pending = await stores.attention.list({ pending: true })
      expect(pending).toHaveLength(1)
      expect(pending[0]?.nodeId).toBe('split/t1/check-loop/approve')
      await stores.attention.answer(pending[0]!.requestId, { decision: 'approve', by: humanActor })

      // 换一个引擎实例（重新打开项目，等价于进程重启）继续跑。
      const reopened = await openProject(root)
      const engine2 = createEngine(depsOf(reopened, { mock: harness }, profiles), { concurrency: 1 })
      const final = await withDeadline(engine2.resume(paused.runId, workflow), 15_000, 'resume 未返回')

      expect(final.status).toBe('succeeded')
      expect(calls.plan).toBe(1) // 恢复走 state.expansions，不重新规划
      expect(calls.draft).toBe(1) // 已成功的 planning 子节点不重跑
      expect(checkRuns).toBe(1) // 容器内已成功的节点同样不重跑
      expect(new Set(Object.values(final.nodes).map((node) => node.status))).toEqual(new Set(['succeeded']))
      expect(final.expansions).toHaveLength(1)

      const onDisk = await reopened.runs.get(paused.runId)
      expect(onDisk?.status).toBe('succeeded')
      expect(onDisk?.nodes['split/t1/check-loop/approve']?.status).toBe('succeeded')
    },
    TEST_TIMEOUT,
  )
})

// ------------------------------------------------------------------ 2. cancel

describe('边界 2：cancel', () => {
  it(
    '取消运行中的 harness：真实 AbortSignal、磁盘终态 cancelled、依赖节点不运行',
    async () => {
      const root = await tempProject('cancel')
      const stores = await initProject(root, { name: '取消' })
      const requirement = await stores.workspaces.createRequirement({ title: '取消' })

      let signalSeen = false
      let aborted = false
      let markEntered: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
      let afterCalls = 0

      const blocking = new TestHarness('blocking-h', (req) => new Promise<HarnessResult>((resolve) => {
        const signal = req.signal
        if (signal === undefined) {
          resolve({ ok: false, finalText: '', error: 'harness 未收到 AbortSignal' })
          return
        }
        signalSeen = true
        const finish = (): void => {
          aborted = true
          resolve({ ok: false, finalText: '', error: 'aborted by signal' })
        }
        markEntered()
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish)
      }))
      const after = new TestHarness('after-h', () => {
        afterCalls += 1
        return textOk('不应运行')
      })

      const workflow = defineWorkflow({
        id: 'cancel', title: '取消', version: '1', stages: [{ id: 's', title: '阶段' }],
        nodes: [
          agent({ id: 'long', title: '长时间执行', role: 'dev', prompt: 'NODE:long' }),
          agent({ id: 'after', title: '后续', role: 'dev', needs: ['long'], prompt: 'NODE:after', harness: { harness: 'after-h' } }),
        ],
      })

      const engine = createEngine(
        depsOf(stores, { 'blocking-h': blocking, 'after-h': after }, { dev: profileOf('dev', 'blocking-h') }),
        { concurrency: 2 },
      )
      const startPromise = engine.start({ workflow, requirementId: requirement.id })
      void startPromise.catch(() => undefined)

      await withDeadline(entered, 10_000, 'harness 未在 10s 内被调用')
      const runId = await pollRunId(stores, requirement.id)
      await engine.cancel(runId)
      const returned = await withDeadline(startPromise, 10_000, 'cancel 后 start 未返回')

      expect(signalSeen).toBe(true)
      expect(aborted).toBe(true)
      expect(afterCalls).toBe(0)

      const reopened = await openProject(root)
      const onDisk = await reopened.runs.get(runId)
      expect(onDisk?.status).toBe('cancelled')
      expect(onDisk?.endedAt).toBeTruthy()
      expect(onDisk?.nodes.long?.status).toBe('cancelled')
      expect(['pending', 'cancelled', 'skipped']).toContain(onDisk?.nodes.after?.status)
      expect(returned.status).toBe(onDisk?.status)

      const events = await reopened.events.read(runId)
      expect(events.some((event) => event.type === 'run.started')).toBe(true)
      const finished = events.filter((event) => event.type === 'run.finished')
      expect(finished.every((event) => (event.data as { status: string }).status === 'cancelled')).toBe(true)
    },
    TEST_TIMEOUT,
  )
})

// ------------------------------------------------------------------ 3. 并发写权限守卫

describe('边界 3：并发写权限守卫', () => {
  it(
    '两个并发 agent 交错写各自合法文件、一个先结束一个后结束，不互相误报 guard.violation',
    async () => {
      const root = await tempProject('guard-ok')
      const stores = await initProject(root, { name: '守卫并发' })
      const requirement = await stores.workspaces.createRequirement({ title: '守卫并发' })

      let arrived = 0
      let release: () => void = () => undefined
      const bothReady = new Promise<void>((resolve) => {
        release = resolve
      })
      const writer = new TestHarness('writer', async (req) => {
        arrived += 1
        if (arrived >= 2) release()
        await withDeadline(bothReady, 8_000, '两个 agent 未并发进入 harness')
        const isA = req.prompt.includes('NODE:a')
        const relative = isA ? 'src/a/one.txt' : 'src/b/two.txt'
        const file = path.join(req.cwd, relative)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, isA ? 'a' : 'b')
        // 两个文件的写都发生在两个节点都在运行期间；A 先结束，B 后结束。
        await sleep(isA ? 40 : 120)
        return textOk('written')
      })

      const workflow = defineWorkflow({
        id: 'guard-ok', title: '守卫并发', version: '1', stages: [{ id: 's', title: '阶段' }],
        nodes: [
          agent({ id: 'a', title: 'A', role: 'dev', writeScope: ['src/a/**'], prompt: 'NODE:a' }),
          agent({ id: 'b', title: 'B', role: 'dev', writeScope: ['src/b/**'], prompt: 'NODE:b' }),
        ],
      })

      const engine = createEngine(
        depsOf(stores, { writer }, { dev: profileOf('dev', 'writer', ['src/**']) }),
        { concurrency: 2 },
      )
      const final = await withDeadline(engine.start({ workflow, requirementId: requirement.id }), 15_000, 'start 未返回')

      expect(final.status).toBe('succeeded')
      expect(final.nodes.a?.status).toBe('succeeded')
      expect(final.nodes.b?.status).toBe('succeeded')
      expect(await readFile(path.join(root, 'src/a/one.txt'), 'utf8')).toBe('a')
      expect(await readFile(path.join(root, 'src/b/two.txt'), 'utf8')).toBe('b')

      const events = await stores.events.read(final.runId)
      expect(events.filter((event) => event.type === 'guard.violation')).toEqual([])
    },
    TEST_TIMEOUT,
  )

  it(
    '节点 writeScope ∩ 角色 writeScope 后仍拦越界写：越界文件记 guard.violation，节点 blocked',
    async () => {
      const root = await tempProject('guard-bad')
      const stores = await initProject(root, { name: '守卫越界' })
      const requirement = await stores.workspaces.createRequirement({ title: '守卫越界' })

      const writer = new TestHarness('writer', async (req) => {
        await mkdir(path.join(req.cwd, 'src/allowed'), { recursive: true })
        await writeFile(path.join(req.cwd, 'src/allowed/ok.txt'), 'ok')
        await writeFile(path.join(req.cwd, 'src/outside.txt'), 'oops')
        return textOk('done')
      })

      const workflow = defineWorkflow({
        id: 'guard-bad', title: '守卫越界', version: '1', stages: [{ id: 's', title: '阶段' }],
        nodes: [agent({ id: 'c', title: 'C', role: 'dev', writeScope: ['src/allowed/**'], prompt: 'NODE:c' })],
      })

      const engine = createEngine(
        depsOf(stores, { writer }, { dev: profileOf('dev', 'writer', ['src/**']) }),
        { concurrency: 1 },
      )
      const final = await withDeadline(engine.start({ workflow, requirementId: requirement.id }), 15_000, 'start 未返回')

      expect(final.nodes.c?.status).toBe('blocked')
      expect(final.status).not.toBe('succeeded')

      const events = await stores.events.read(final.runId)
      const violations = events.filter((event) => event.type === 'guard.violation')
      expect(violations.length).toBeGreaterThanOrEqual(1)
      const paths = violations.flatMap((event) => (event.data as { paths: string[] }).paths)
      expect(paths.some((item) => item.endsWith('src/outside.txt'))).toBe(true)
      expect(paths.every((item) => item.endsWith('src/outside.txt'))).toBe(true)
      for (const violation of violations) {
        expect(['flagged', 'blocked', 'reverted']).toContain((violation.data as { action: string }).action)
      }
    },
    TEST_TIMEOUT,
  )
})

// ------------------------------------------------------------------ 4. markStale 传播

describe('边界 4：markStale 跨动态 planner 节点传播', () => {
  it(
    'planner 子节点读过的产物被改：子节点、planner 父、下游都 stale；未读该产物的兄弟节点不受影响',
    async () => {
      const root = await tempProject('stale')
      const stores = await initProject(root, { name: '过期传播' })
      const requirement = await stores.workspaces.createRequirement({ title: '过期传播' })
      await stores.workspaces.writeArtifact({
        ref: { workspace: requirement.id, path: 'spec/spec.md' }, content: 'AC-1: 可交付', kind: 'spec', author: humanActor, reason: '建立测试基线',
      })
      await stores.workspaces.writeArtifact({
        ref: { workspace: requirement.id, path: 'inputs/other.md' }, content: '其他输入', kind: 'input', author: humanActor, reason: '建立测试基线',
      })

      const harness = new TestHarness('mock', async (req) => {
        const text = req.prompt
        if (text.includes('PLAN:')) {
          return structuredOk({
            items: [
              { key: 't1', title: '读 spec', role: 'dev', params: { input: 'spec/spec.md', output: 'out/child-t1.md' } },
              { key: 't2', title: '读 other', role: 'dev', params: { input: 'inputs/other.md', output: 'out/child-t2.md' } },
            ],
          })
        }
        if (text.includes('NODE:child:t1')) {
          await writeWorkspaceFile(req.env, 'out/child-t1.md')
          return textOk('t1')
        }
        if (text.includes('NODE:child:t2')) {
          await writeWorkspaceFile(req.env, 'out/child-t2.md')
          return textOk('t2')
        }
        if (text.includes('NODE:after')) {
          await writeWorkspaceFile(req.env, 'out/after.md')
          return textOk('after')
        }
        throw new Error(`未预期的 harness 调用：${text.slice(0, 120)}`)
      })

      const workflow = defineWorkflow({
        id: 'stale', title: '过期传播', version: '1', stages: [{ id: 's', title: '阶段' }],
        nodes: [
          planner({
            id: 'plan', title: '规划', role: 'architect', prompt: 'PLAN: 拆任务', maxItems: 4, allowedRoles: ['dev'],
            expand: (item) => [
              agent({
                id: 'child', title: `子任务 ${item.key}`, role: 'dev', writeScope: [`${path.relative(root, stores.workspaces.dir(requirement.id))}/out/child-${item.key}.md`],
                inputs: [{ path: String(item.params?.input) }],
                outputs: [{ path: String(item.params?.output), kind: 'other' }],
                prompt: `NODE:child:${item.key}`,
              }),
            ],
          }),
          agent({
            id: 'after', title: '下游', role: 'dev', needs: ['plan'],
            inputs: [{ path: 'out/child-t1.md' }],
            outputs: [{ path: 'out/after.md', kind: 'other' }],
            prompt: 'NODE:after',
          }),
        ],
      })

      const engine = createEngine(
        depsOf(stores, { mock: harness }, { architect: profileOf('architect', 'mock'), dev: profileOf('dev', 'mock') }),
        { concurrency: 2 },
      )
      const final = await withDeadline(engine.start({ workflow, requirementId: requirement.id }), 20_000, 'start 未返回')
      expect(final.status).toBe('succeeded')

      const reopened = await openProject(root)
      const freshEngine = createEngine(depsOf(reopened, { mock: harness }, {
        architect: profileOf('architect', 'mock'), dev: profileOf('dev', 'mock'),
      }))
      const stale = await freshEngine.markStale(final.runId, { workspace: requirement.id, path: 'spec/spec.md' })
      expect(new Set(stale)).toEqual(new Set(['plan/t1/child', 'plan', 'after']))

      const state = await stores.runs.get(final.runId)
      expect(state?.nodes['plan/t1/child']?.status).toBe('stale')
      expect(state?.nodes.plan?.status).toBe('stale')
      expect(state?.nodes.after?.status).toBe('stale')
      // 兄弟条目没读过被改的产物，也不是被改节点的下游。
      expect(state?.nodes['plan/t2/child']?.status).toBe('succeeded')

      const events = await stores.events.read(final.runId)
      const staleEvents = events.filter((event) => event.type === 'node.stale')
      expect(new Set(staleEvents.map((event) => event.nodeId))).toEqual(new Set(['plan/t1/child', 'plan', 'after']))
      for (const event of staleEvents) {
        expect((event.data as { cause: { path: string } }).cause.path).toBe('spec/spec.md')
      }
    },
    TEST_TIMEOUT,
  )
})

// ------------------------------------------------------------------ 5. planner 非法规划 fail-closed

describe('边界 5：planner 非法规划 fail-closed', () => {
  const cases: Array<{ name: string; items: PlannedItem[]; hint: RegExp }> = [
    { name: '重复 key', items: [{ key: 'dup', title: 'A' }, { key: 'dup', title: 'B' }], hint: /dup/ },
    {
      name: '条目依赖成环',
      items: [{ key: 'a', title: 'A', dependsOn: ['b'] }, { key: 'b', title: 'B', dependsOn: ['a'] }],
      hint: /环|cycle|circular/,
    },
    { name: '非法角色', items: [{ key: 'x', title: 'X', role: 'ghost' }], hint: /ghost/ },
  ]

  it.each(cases)(
    '$name：planner 节点失败、不展开、下游不运行',
    async ({ items, hint }) => {
      const root = await tempProject('planner-bad')
      const stores = await initProject(root, { name: '非法规划' })
      const requirement = await stores.workspaces.createRequirement({ title: '非法规划' })

      let planCalls = 0
      let childCalls = 0
      const harness = new TestHarness('mock', (req) => {
        const text = req.prompt
        if (text.includes('PLAN:')) {
          planCalls += 1
          return structuredOk({ items })
        }
        if (text.includes('NODE:child')) {
          childCalls += 1
          return textOk('child')
        }
        throw new Error(`未预期的 harness 调用：${text.slice(0, 120)}`)
      })

      const workflow = defineWorkflow({
        id: 'planner-bad', title: '非法规划', version: '1', stages: [{ id: 's', title: '阶段' }],
        nodes: [
          planner({
            id: 'plan', title: '规划', role: 'architect', prompt: 'PLAN: 拆任务', maxItems: 4, allowedRoles: ['dev'],
            expand: () => [agent({ id: 'child', title: '子任务', role: 'dev', prompt: 'NODE:child' })],
          }),
          agent({ id: 'next', title: '下游', role: 'dev', needs: ['plan'], prompt: 'NODE:next' }),
        ],
      })

      const engine = createEngine(
        depsOf(stores, { mock: harness }, { architect: profileOf('architect', 'mock'), dev: profileOf('dev', 'mock') }),
        { concurrency: 2 },
      )
      const final = await withDeadline(engine.start({ workflow, requirementId: requirement.id }), 15_000, 'start 未返回')

      expect(final.status).toBe('failed')
      expect(final.nodes.plan?.status).toBe('failed')
      expect(final.nodes.plan?.error ?? '').toMatch(hint)
      expect(final.expansions).toEqual([])
      expect(Object.keys(final.nodes).filter((id) => id.startsWith('plan/'))).toEqual([])
      expect(planCalls).toBe(1)
      expect(childCalls).toBe(0)
      expect(final.nodes.next?.status).toBe('pending')

      const events = await stores.events.read(final.runId)
      expect(events.some((event) => event.type === 'dag.expanded')).toBe(false)
    },
    TEST_TIMEOUT,
  )
})

// ------------------------------------------------------------------ 6. harnessOverride

describe('边界 6：harnessOverride 强制所有模型节点走覆盖 harness', () => {
  it(
    'agent / judge / rubric / planner 都走 override，原 harness 一次都不被调用',
    async () => {
      const root = await tempProject('override')
      const stores = await initProject(root, { name: '覆盖' })
      const requirement = await stores.workspaces.createRequirement({ title: '覆盖' })

      const seen: string[] = []
      const orig = new TestHarness('orig-h', () => {
        throw new Error('不应调用原 harness')
      })
      const override = new TestHarness('override-h', (req) => {
        const text = `${req.prompt}\n${req.systemAppend ?? ''}`
        if (text.includes('PLAN:')) {
          seen.push('planner')
          return structuredOk({ items: [{ key: 'a', title: 'A', role: 'dev' }] })
        }
        if (text.includes('RUBRIC:检查覆盖')) {
          seen.push('rubric')
          return structuredOk({ score: 90, pass: true, message: 'ok' })
        }
        if (text.includes('TC-1') || req.env?.TAKT_ROLE === 'judge') {
          seen.push('judge')
          return structuredOk({
            verdicts: [{ subject: 'TC-1', category: 'product_bug', confidence: 0.9, rationale: '回归失败', evidence: [] }],
          })
        }
        if (text.includes('NODE:agent')) {
          seen.push('agent')
          return textOk('done')
        }
        if (text.includes('NODE:fix')) {
          seen.push('fix')
          return textOk('fixed')
        }
        throw new Error(`未预期的 harness 调用：${text.slice(0, 120)}`)
      })

      const workflow = defineWorkflow({
        id: 'override', title: '覆盖', version: '1', stages: [{ id: 's', title: '阶段' }],
        nodes: [
          agent({ id: 'write', title: '执行', role: 'dev', prompt: 'NODE:agent' }),
          gate({
            id: 'rubric-gate', title: '评分门禁', needs: ['write'], onFail: 'stop',
            checks: [{ id: 'r', kind: 'rubric', role: 'reviewer', rubric: 'RUBRIC:检查覆盖', threshold: 80 }],
          }),
          script({ id: 'failing', title: '失败结果', needs: ['write'], run: async () => ({ data: { failures: [{ subject: 'TC-1' }] } }) }),
          judge({ id: 'judge', title: '判决', role: 'judge', needs: ['failing'], target: 'failing', routes: { product_bug: 'fix' } }),
          agent({ id: 'fix', title: '修复', role: 'dev', needs: ['judge'], prompt: 'NODE:fix' }),
          planner({
            id: 'plan', title: '规划', role: 'architect', needs: ['fix'], prompt: 'PLAN: 拆任务', maxItems: 2, allowedRoles: ['dev'],
            expand: () => [script({ id: 'noop', title: '空节点', run: async () => undefined })],
          }),
        ],
      })

      const profiles = {
        dev: profileOf('dev', 'orig-h'),
        judge: profileOf('judge', 'orig-h'),
        architect: profileOf('architect', 'orig-h'),
        reviewer: profileOf('reviewer', 'orig-h'),
      }
      const engine = createEngine(
        depsOf(stores, { 'orig-h': orig, 'override-h': override }, profiles),
        { harnessOverride: 'override-h', concurrency: 1 },
      )
      const final = await withDeadline(engine.start({ workflow, requirementId: requirement.id }), 20_000, 'start 未返回')

      expect(final.status).toBe('succeeded')
      expect(orig.calls).toEqual([])
      expect(seen).toContain('agent')
      expect(seen).toContain('rubric')
      expect(seen).toContain('judge')
      expect(seen).toContain('fix')
      expect(seen).toContain('planner')
      expect(final.nodes['rubric-gate']?.status).toBe('succeeded')
      expect(final.nodes.judge?.status).toBe('succeeded')
      expect(final.nodes.plan?.status).toBe('succeeded')
    },
    TEST_TIMEOUT,
  )
})
