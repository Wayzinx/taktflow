import type { NodeDef, SnapshotNode, WorkflowDefinition, WorkflowSnapshot } from '../types.js'

export function snapshotWorkflow(def: WorkflowDefinition): WorkflowSnapshot {
  const snapshot: WorkflowSnapshot = {
    id: def.id,
    title: def.title,
    description: def.description,
    useWhen: def.useWhen, tiers: def.tiers, leadInstructions: def.leadInstructions, dynamicRules: def.dynamicRules, budget: def.budget,
    version: def.version,
    stages: def.stages,
    nodes: def.nodes.map(snapshotNode),
  }
  // schema 等开放字段也可能包含函数；按 JSON 语义清理并脱离原定义的引用。
  return JSON.parse(JSON.stringify(snapshot, (_key, value: unknown) =>
    typeof value === 'function' ? undefined : value)) as WorkflowSnapshot
}

function snapshotNode(node: NodeDef): SnapshotNode {
  const snapshot: SnapshotNode = {
    id: node.id,
    kind: node.kind,
    title: node.title,
    goal: node.goal, owner: node.owner,
    stage: node.stage,
    needs: node.needs ?? [],
    inputs: node.inputs,
    outputs: node.outputs,
  }
  switch (node.kind) {
    case 'agent':
      snapshot.completion = node.completion
      snapshot.writeScope = node.writeScope
      snapshot.prompt = typeof node.prompt === 'string' ? node.prompt : undefined
      snapshot.repo = node.repo
      snapshot.role = node.role
      snapshot.harness = node.harness?.harness
      break
    case 'review':
      snapshot.review = { target: node.target, author: node.author.role,
        reviewers: node.reviewers.map((reviewer) => ({ role: reviewer.role, focus: reviewer.focus, harness: reviewer.harness?.harness })),
        pass: node.pass ?? 'all', maxRounds: node.maxRounds, onExhausted: node.onExhausted, humanSignoff: node.humanSignoff, stopAfterNoProgress: node.stopAfterNoProgress,
        arbiter: node.arbiter && { role: node.arbiter.role, focus: node.arbiter.focus, harness: node.arbiter.harness?.harness } }
      break
    case 'judge':
      snapshot.role = node.role
      snapshot.harness = node.harness?.harness
      snapshot.target = node.target
      snapshot.routes = node.routes
      break
    case 'loop':
      snapshot.body = node.body.map(snapshotNode)
      snapshot.maxIterations = node.maxIterations
      break
    case 'planner':
      snapshot.prompt = typeof node.prompt === 'string' ? node.prompt : undefined
      snapshot.role = node.role
      snapshot.harness = node.harness?.harness
      snapshot.maxItems = node.maxItems
      snapshot.allowedRoles = node.allowedRoles
      break
    case 'gate':
      snapshot.checks = node.checks.map((check) => ({ id: check.id, kind: check.kind, title: check.title, ...(check.kind === 'rubric' ? { threshold: check.threshold, role: check.role } : check.kind === 'acceptance' ? { role: check.role } : {}) }))
      break
    case 'human':
      snapshot.ask = node.ask
      snapshot.form = node.form
      snapshot.choices = node.choices
      break
  }
  return snapshot
}
