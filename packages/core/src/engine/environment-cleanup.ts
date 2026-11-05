import type { ProjectStores } from '../interfaces.js'
import type { NodeContext, RunState } from '../types.js'
import { bindEnvironment } from './environment-config.js'
import { teardownEnvironment } from './environment.js'
import { system } from './actor.js'

/** 环境专用的终止收尾：不通过已取消的调度器执行。 */
export async function finalizeEnvironment(stores: ProjectStores, state: RunState): Promise<void> {
  const node = state.nodes['env-teardown']
  if (!node || node.status === 'succeeded' || node.status === 'skipped') return
  const logs: Promise<unknown>[] = []
  const ctx: NodeContext = {
    runId: state.runId, requirementId: state.requirementId, nodeId: node.id,
    projectDir: stores.projectDir, workspaceDir: stores.workspaces.dir(state.requirementId), args: state.args,
    signal: AbortSignal.timeout(120_000), resultOf: (id) => state.nodes[id]?.result,
    readArtifact: async (path) => (await stores.workspaces.readArtifact({ workspace: state.requirementId, path }))?.toString('utf8'),
    log: (message) => { logs.push(stores.events.append(state.runId, { type: 'log', nodeId: node.id, actor: system, data: { level: 'info', message } })) },
  }
  bindEnvironment(ctx, stores.config.environment)
  node.attempts++
  node.status = 'running'
  node.startedAt = new Date().toISOString()
  delete node.error
  await stores.runs.save(state)
  await stores.events.append(state.runId, { type: 'node.started', nodeId: node.id, actor: system, data: { attempt: node.attempts } })
  try { await teardownEnvironment(ctx) }
  catch { ctx.log('环境回收未完成（仅记录），请人工检查环境资源') }
  await Promise.all(logs)
  node.status = stores.config.environment?.teardown ? 'succeeded' : 'skipped'
  node.endedAt = new Date().toISOString()
  await stores.runs.save(state)
  await stores.events.append(state.runId, { type: 'node.finished', nodeId: node.id, actor: system, data: { status: node.status, outputs: node.outputs } })
}
