/**
 * 临时任务运行（Lead 的 dispatch_task）：`task` 小 workflow，默认 实现 → 评审 两个节点。
 * 演示数据里它就是一次普通运行，运行页、节点抽屉都能打开；状态由群聊脚本推进。
 */
import type { Actor, ArtifactRef, EventEnvelope, EventPayloads, EventType, GraphNode, NodeStatus, Usage } from '@taktflow/core'
import type { MockDb, MockRun, TplNode } from './mock-data'

const ENGINE: Actor = { type: 'system', id: 'engine' }
const STAGE = { id: 'task', title: '临时任务' }

export function pushEvent<T extends EventType>(run: MockRun, type: T, actor: Actor, data: EventPayloads[T], nodeId?: string): EventEnvelope {
  const prev = run.events[run.events.length - 1]
  const seq = (prev?.seq ?? 0) + 1
  const prevHash = prev?.hash ?? '0'.repeat(64)
  const e = { seq, ts: new Date().toISOString(), runId: run.state.runId, nodeId, type, actor, data, prevHash, hash: (prevHash.slice(8) + seq.toString(16).padStart(8, '0')).slice(-64) } as EventEnvelope
  run.events.push(e)
  return e
}

export interface TaskNodeSpec {
  id: string
  kind: 'agent' | 'review'
  title: string
  role: string
  harness: string
  model: string
  prompt: string
}

export interface TaskRun {
  run: MockRun
  start(nodeId: string): void
  finish(nodeId: string, status: NodeStatus, outputs?: ArtifactRef[], usage?: Usage): void
  end(status: 'succeeded' | 'failed'): void
}

export function createTaskRun(db: MockDb, opts: { runId: string; requirementId: string; title: string; by: Actor; nodes: TaskNodeSpec[]; worktree: { repo: string; branch: string; base: string } }): TaskRun {
  const now = new Date().toISOString()
  const tpl = new Map<string, TplNode>()
  const graph: GraphNode[] = []
  const states: MockRun['state']['nodes'] = {}
  opts.nodes.forEach((n, i) => {
    const needs = i > 0 ? [opts.nodes[i - 1]!.id] : []
    tpl.set(n.id, { id: n.id, kind: n.kind, title: n.title, stage: STAGE.id, needs, role: n.role, prompt: n.prompt })
    graph.push({ id: n.id, kind: n.kind, title: n.title, stage: STAGE.id, status: i === 0 ? 'ready' : 'pending', role: n.role, harness: n.harness, attempts: 0 })
    states[n.id] = { id: n.id, status: i === 0 ? 'ready' : 'pending', attempts: 0, outputs: [] }
  })
  const run: MockRun = {
    state: { runId: opts.runId, workflowId: 'task', workflowVersion: '0.1.0', requirementId: opts.requirementId, status: 'running', startedAt: now, args: { title: opts.title }, nodes: states, expansions: [] },
    workflow: { id: 'task', title: `临时任务 · ${opts.title}`, version: '0.1.0', stages: [STAGE] },
    graph: { nodes: graph, edges: opts.nodes.slice(1).map((n, i) => ({ from: opts.nodes[i]!.id, to: n.id, kind: 'dep' as const })) },
    events: [],
    tpl,
    context: new Map(),
    prompts: new Map(opts.nodes.map((n) => [n.id, n.prompt])),
    gates: {},
    live: [],
  }
  db.runs.set(opts.runId, run)
  pushEvent(run, 'run.started', ENGINE, { workflowId: 'task', workflowVersion: '0.1.0', args: { title: opts.title } })
  const actorOf = (id: string): Actor => {
    const n = opts.nodes.find((x) => x.id === id)!
    return { type: 'agent', role: n.role, harness: n.harness, model: n.model }
  }
  const set = (id: string, status: NodeStatus) => {
    run.graph.nodes.find((g) => g.id === id)!.status = status
    run.state.nodes[id]!.status = status
  }

  return {
    run,
    start(id) {
      const st = run.state.nodes[id]!
      st.attempts += 1
      st.startedAt = new Date().toISOString()
      run.graph.nodes.find((g) => g.id === id)!.attempts = st.attempts
      set(id, 'running')
      run.live = [id]
      if (id === opts.nodes[0]!.id) {
        const wt = { ...opts.worktree, path: `.takt/worktrees/${opts.runId}` }
        st.worktree = wt
        pushEvent(run, 'worktree.created', ENGINE, wt, id)
      }
      pushEvent(run, 'node.started', actorOf(id), { attempt: st.attempts }, id)
    },
    finish(id, status, outputs = [], usage) {
      const st = run.state.nodes[id]!
      st.endedAt = new Date().toISOString()
      st.outputs = outputs
      st.usage = usage
      run.graph.nodes.find((g) => g.id === id)!.usage = usage
      set(id, status)
      run.live = run.live.filter((x) => x !== id)
      const next = run.graph.edges.find((e) => e.from === id)?.to
      if (next && status === 'succeeded') set(next, 'ready')
      pushEvent(run, 'node.finished', actorOf(id), { status, outputs, usage }, id)
    },
    end(status) {
      run.state.status = status
      run.state.endedAt = new Date().toISOString()
      run.live = []
      pushEvent(run, 'run.finished', ENGINE, { status })
    },
  }
}
