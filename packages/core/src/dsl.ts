/**
 * Workflow DSL：用 TypeScript 代码定义 DAG。
 *
 * 构造函数只做两件事：补默认值、在 defineWorkflow 里做静态校验（ID 唯一、依赖存在、无环）。
 * 引擎、CLI、Web 都只认 WorkflowDefinition 这个纯数据结构（函数字段除外）。
 */
import type {
  AgentNodeDef,
  GateNodeDef,
  HumanNodeDef,
  JudgeNodeDef,
  LoopNodeDef,
  NodeDef,
  PlannerNodeDef,
  ScriptNodeDef,
  SubflowNodeDef,
  TaktConfig,
  WorkflowDefinition,
} from './types.js'

type Spec<T extends NodeDef> = Omit<T, 'kind'>

export const script = (spec: Spec<ScriptNodeDef>): ScriptNodeDef => ({ kind: 'script', ...spec })
export const agent = (spec: Spec<AgentNodeDef>): AgentNodeDef => ({ kind: 'agent', session: 'fresh', ...spec })
export const gate = (spec: Spec<GateNodeDef>): GateNodeDef => ({ kind: 'gate', onFail: 'stop', ...spec })
export const human = (spec: Spec<HumanNodeDef>): HumanNodeDef => ({ kind: 'human', ...spec })
export const judge = (spec: Spec<JudgeNodeDef>): JudgeNodeDef => ({ kind: 'judge', ...spec })
export const loop = (spec: Spec<LoopNodeDef>): LoopNodeDef => ({ kind: 'loop', onExhausted: 'human', ...spec })
export const planner = (spec: Spec<PlannerNodeDef>): PlannerNodeDef => ({ kind: 'planner', ...spec })
export const subflow = (spec: Spec<SubflowNodeDef>): SubflowNodeDef => ({ kind: 'subflow', ...spec })

export class WorkflowDefinitionError extends Error {}

/** 定义 workflow 并做静态校验；校验不过直接抛错，不让坏流程进引擎。 */
export function defineWorkflow(def: WorkflowDefinition): WorkflowDefinition {
  validateNodes(def.nodes, new Set(def.stages.map((s) => s.id)), def.id)
  return def
}

export function defineConfig(config: TaktConfig): TaktConfig {
  return config
}

function validateNodes(nodes: NodeDef[], stages: Set<string>, scope: string): void {
  const ids = new Set<string>()
  for (const n of nodes) {
    if (ids.has(n.id)) throw new WorkflowDefinitionError(`[${scope}] 节点 ID 重复：${n.id}`)
    ids.add(n.id)
  }
  for (const n of nodes) {
    for (const dep of n.needs ?? []) {
      if (!ids.has(dep)) throw new WorkflowDefinitionError(`[${scope}] ${n.id} 依赖不存在的节点：${dep}`)
    }
    if (n.stage && !stages.has(n.stage)) throw new WorkflowDefinitionError(`[${scope}] ${n.id} 的阶段未声明：${n.stage}`)
    if (n.kind === 'judge' && !ids.has(n.target)) throw new WorkflowDefinitionError(`[${scope}] ${n.id} 的判决目标不存在：${n.target}`)
    if (n.kind === 'loop') validateNodes(n.body, stages, `${scope}/${n.id}`)
  }
  assertAcyclic(nodes, scope)
}

function assertAcyclic(nodes: NodeDef[], scope: string): void {
  const needs = new Map(nodes.map((n) => [n.id, n.needs ?? []]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') throw new WorkflowDefinitionError(`[${scope}] 存在环：${[...path, id].join(' → ')}`)
    state.set(id, 'visiting')
    for (const dep of needs.get(id) ?? []) visit(dep, [...path, id])
    state.set(id, 'done')
  }
  for (const n of nodes) visit(n.id, [])
}
