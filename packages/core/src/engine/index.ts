import type { Engine, EngineDeps } from '../interfaces.js'
import type { RunState } from '../types.js'
import { newRunId } from '../util/ids.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { readJsonFile } from '../store/fs-utils.js'
import { validateDag } from './graph.js'
import { WriteGuard } from './guard.js'
import { Runtime, runtimeFile, system, type EngineOptions, type RuntimeRecord } from './runtime.js'

export type { EngineOptions } from './runtime.js'

export function createEngine(deps: EngineDeps, opts: EngineOptions = {}): Engine {
  const concurrency = opts.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency 必须是正整数')
  const active = new Map<string, Runtime>()
  const guard = new WriteGuard(deps.stores.projectDir)
  const timestamp = () => (opts.now?.() ?? new Date()).toISOString()
  async function execute(runtime: Runtime, resume = false): Promise<RunState> {
    const id = runtime.state.runId
    if (active.has(id)) throw new Error(`运行正在执行：${id}`)
    active.set(id, runtime)
    try {
      const persisted = await deps.stores.runs.get(id)
      if (persisted?.status === 'cancelled') return persisted
      await runtime.prepare()
      if (resume) await runtime.restoreAnswers()
      return await runtime.run()
    } finally { active.delete(id) }
  }
  return {
    async start(input) {
      validateDag(input.workflow.nodes)
      if (!await deps.stores.workspaces.getRequirement(input.requirementId)) throw new Error(`需求不存在：${input.requirementId}`)
      const now = opts.now?.() ?? new Date()
      const state: RunState = {
        runId: newRunId(now), workflowId: input.workflow.id, workflowVersion: input.workflow.version,
        requirementId: input.requirementId, status: 'running', startedAt: now.toISOString(),
        args: input.args ?? {}, nodes: {}, expansions: [],
      }
      for (const node of input.workflow.nodes) state.nodes[node.id] = { id: node.id, status: 'pending', attempts: 0, outputs: [] }
      await deps.stores.runs.create(state, snapshotWorkflow(input.workflow))
      await deps.stores.events.append(state.runId, { type: 'run.started', actor: system, data: {
        workflowId: state.workflowId, workflowVersion: state.workflowVersion, args: state.args,
      } })
      return execute(new Runtime(deps, state, input.workflow, opts, guard))
    },
    async resume(runId, workflow) {
      if (active.has(runId)) throw new Error(`运行正在执行：${runId}`)
      const state = await deps.stores.runs.get(runId)
      if (!state) throw new Error(`运行不存在：${runId}`)
      if (workflow.id !== state.workflowId || workflow.version !== state.workflowVersion) throw new Error('恢复的 workflow ID/version 与运行不匹配')
      if (state.status === 'cancelled') return state
      return execute(new Runtime(deps, state, workflow, opts, guard), true)
    },
    async cancel(runId) {
      const runtime = active.get(runId)
      const state = runtime?.state ?? await deps.stores.runs.get(runId)
      if (!state) throw new Error(`运行不存在：${runId}`)
      if (state.status === 'cancelled' || state.status === 'succeeded' || state.status === 'failed') return
      state.status = 'cancelled'
      state.endedAt = timestamp()
      for (const node of Object.values(state.nodes)) if (node.status === 'running' || node.status === 'ready' || node.status === 'waiting_human') {
        node.status = 'cancelled'
        node.endedAt = timestamp()
      }
      if (runtime) {
        runtime.controller.abort(new Error('运行已取消'))
        await runtime.save()
      } else {
        await deps.stores.runs.save(state)
      }
      for (const item of await deps.stores.attention.list({ pending: true, requirementId: state.requirementId })) {
        if (item.runId !== runId) continue
        const answered = await deps.stores.attention.answer(item.requestId, { decision: 'cancelled', by: system })
        if (runtime) { await runtime.recordAnswer(answered); continue }
        const events = await deps.stores.events.read(runId, { nodeId: item.nodeId, types: ['human.answered'] })
        if (!events.some((event) => (event.data as { requestId: string }).requestId === item.requestId)) {
          await deps.stores.events.append(runId, { type: 'human.answered', actor: system, nodeId: item.nodeId, data: { requestId: item.requestId, decision: 'cancelled' } })
        }
      }
      if (!runtime) await deps.stores.events.append(runId, { type: 'run.finished', actor: system, data: { status: 'cancelled' } })
    },
    async markStale(runId, cause) {
      const runtime = active.get(runId)
      const state = runtime?.state ?? await deps.stores.runs.get(runId)
      if (!state) throw new Error(`运行不存在：${runId}`)
      const record = await readJsonFile<RuntimeRecord>(runtimeFile(deps, runId))
      if (!record) throw new Error(`运行缺少引擎依赖记录：${runId}`)
      const affected = new Set(Object.values(state.nodes).filter((node) => node.inputs?.some((input) =>
        input.workspace === cause.workspace && input.path === cause.path)).map((node) => node.id))
      let changed = true
      while (changed) {
        changed = false
        for (const node of record.nodes) {
          if (affected.has(node.id) && node.parent && !affected.has(node.parent)) { affected.add(node.parent); changed = true }
          if (!affected.has(node.id) && node.needs.some((id) => affected.has(id))) { affected.add(node.id); changed = true }
        }
      }
      for (const id of affected) {
        if (!state.nodes[id]) continue
        state.nodes[id]!.status = 'stale'
        if (runtime) await runtime.emit('node.stale', { cause }, id)
        else {
          await deps.stores.runs.save(state)
          await deps.stores.events.append(runId, { type: 'node.stale', actor: system, nodeId: id, data: { cause } })
        }
      }
      return [...affected]
    },
  }
}
