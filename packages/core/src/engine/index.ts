import { mergeBudget } from '../util/budget.js'
import { relative } from 'node:path'
import type { Engine, EngineDeps } from '../interfaces.js'
import type { RunState } from '../types.js'
import { newRunId } from '../util/ids.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { persistArtifactInvalidation } from '../store/artifact-edits.js'
import { withFileLock } from '../store/file-lock.js'
import { configureRepositories } from './repository-options.js'
import { configureReviews } from './review-options.js'
import { postEventMessage } from './chat-events.js'
import { answerOrRead, recordAnswerOnce } from './answers.js'
import { requirementLock, updateRequirement } from './requirement.js'
import { validateDag } from './graph.js'
import { assertSupportedNodes } from './kinds.js'
import { validateWorkflowHarnesses } from './selection.js'
import { WriteGuard } from './guard.js'
import { Runtime, system, type EngineOptions } from './runtime.js'
import { finalizeEnvironment } from './environment-cleanup.js'
import { validateEnvironment } from './environment-config.js'

export type { EngineOptions } from './runtime.js'

export function createEngine(deps: EngineDeps, opts: EngineOptions = {}): Engine {
  const concurrency = opts.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency 必须是正整数')
  const active = new Map<string, Runtime>()
  const guard = new WriteGuard(deps.stores.projectDir, relative(deps.stores.projectDir, deps.stores.paths.requirements), relative(deps.stores.projectDir, deps.stores.paths.evals ?? `${deps.stores.taktDir}/evals`))
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
      validateEnvironment(deps.stores.config.environment)
      input = { ...input, workflow: configureRepositories(configureReviews(input.workflow, input.args ?? {}), input.args ?? {}) }
      assertSupportedNodes(input.workflow.nodes)
      validateWorkflowHarnesses(input.workflow, { config: deps.stores.config, profiles: deps.profiles, harnesses: deps.harnesses }, opts.harnessOverride)
      validateDag(input.workflow.nodes, new Set(input.workflow.stages.map((stage) => stage.id)))
      if (!await deps.stores.workspaces.getRequirement(input.requirementId)) throw new Error(`需求不存在：${input.requirementId}`)
      const now = opts.now?.() ?? new Date()
      const state: RunState = {
        runId: newRunId(now), workflowId: input.workflow.id, workflowVersion: input.workflow.version,
        requirementId: input.requirementId, status: 'running', startedAt: now.toISOString(),
        args: input.args ?? {}, nodes: {}, expansions: [],
        budget: mergeBudget(deps.stores.config.budget, input.workflow.budget, input.budget),
        route: input.route, kind: input.kind, origin: input.origin,
      }
      for (const node of input.workflow.nodes) state.nodes[node.id] = { id: node.id, status: 'pending', attempts: 0, outputs: [] }
      await withFileLock(requirementLock(deps.stores, state.requirementId), () => deps.stores.runs.create(state, snapshotWorkflow(input.workflow)))
      await updateRequirement(deps.stores, state, snapshotWorkflow(input.workflow))
      const started = await deps.stores.events.append(state.runId, { type: 'run.started', actor: system, data: {
        workflowId: state.workflowId, workflowVersion: state.workflowVersion, args: state.args,
      } })
      await postEventMessage(deps.stores, state, started)
      if (state.route) {
        const routed = await deps.stores.events.append(state.runId, { type: 'route.decided', actor: system, data: state.route })
        await postEventMessage(deps.stores, state, routed)
      }
      return execute(new Runtime(deps, state, input.workflow, opts, guard))
    },
    async resume(runId, workflow) {
      validateEnvironment(deps.stores.config.environment)
      if (active.has(runId)) throw new Error(`运行正在执行：${runId}`)
      const state = await deps.stores.runs.get(runId)
      if (!state) throw new Error(`运行不存在：${runId}`)
      if (workflow.id !== state.workflowId || workflow.version !== state.workflowVersion) throw new Error('恢复的 workflow ID/version 与运行不匹配')
      if (state.status === 'cancelled') return state
      workflow = configureRepositories(configureReviews(workflow, state.args), state.args)
      assertSupportedNodes(workflow.nodes)
      validateWorkflowHarnesses(workflow, { config: deps.stores.config, profiles: deps.profiles, harnesses: deps.harnesses }, opts.harnessOverride)
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
        const answered = await answerOrRead(deps.stores, item, { decision: 'cancelled', by: system })
        await recordAnswerOnce(deps.stores, runId, answered)
      }
      await updateRequirement(deps.stores, state)
      if (!runtime) {
        await finalizeEnvironment(deps.stores, state)
        const event = await deps.stores.events.append(runId, { type: 'run.finished', actor: system, data: { status: 'cancelled' } })
        await postEventMessage(deps.stores, state, event)
      }
    },
    async markStale(runId, cause) {
      const runtime = active.get(runId)
      const state = runtime?.state ?? await deps.stores.runs.get(runId)
      if (!state) throw new Error(`运行不存在：${runId}`)
      if (runtime) await runtime.save()
      const affected = await persistArtifactInvalidation(deps.stores, runId, cause)
      for (const id of affected) state.nodes[id]!.status = 'stale'
      if (runtime) await runtime.save()
      else await deps.stores.runs.save(state)
      for (const id of affected) {
        if (runtime) await runtime.emit('node.stale', { cause }, id)
        else {
          await deps.stores.events.append(runId, { type: 'node.stale', actor: system, nodeId: id, data: { cause } })
        }
      }
      return [...affected]
    },
  }
}
