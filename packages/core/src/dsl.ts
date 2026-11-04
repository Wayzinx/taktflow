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
  TaktPlugin,
  WorkflowDefinition,
} from './types.js'

import { validateDag } from './engine/graph.js'

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
  try { validateDag(def.nodes, new Set(def.stages.map((s) => s.id)), def.id) } catch (error) {
    throw new WorkflowDefinitionError(error instanceof Error ? error.message : String(error), { cause: error })
  }
  return def
}

export function defineConfig(config: TaktConfig): TaktConfig {
  return config
}

export function definePlugin(plugin: TaktPlugin): TaktPlugin {
  return plugin
}
