import { skillContentHash } from '../util/skill-hash.js'
export { skillContentHash } from '../util/skill-hash.js'
import { recipeInputsLog } from './recipe-record.js'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventEnvelope, NodeRecipe, SnapshotNode } from '../types.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { isEnoent, readFileIfExists } from '../store/fs-utils.js'
import type { HarnessHost } from './harness.js'
import type { AgentNodeDef, HarnessSelector } from '../types.js'

export function recipeOf(events: EventEnvelope[], nodeId: string): NodeRecipe | undefined {
  return events.filter((e) => e.type === 'node.recipe' && e.nodeId === nodeId).at(-1)?.data as NodeRecipe | undefined
}

export function recipeKey(recipe: Omit<NodeRecipe, 'recipeKey'>): string {
  const { lessons: _lessons, ...identity } = recipe
  return sha256(canonicalJson(identity)).slice(0, 16)
}

export function snapshotNodes(nodes: SnapshotNode[], prefix = ''): SnapshotNode[] {
  return nodes.flatMap((node) => {
    const id = prefix && !node.id.startsWith(prefix) ? `${prefix}${node.id}` : node.id
    return [{ ...node, id }, ...snapshotNodes(node.body ?? [], `${id}/`)]
  })
}

export async function loadedSkills(cwd: string, harness: string): Promise<NodeRecipe['skills']> {
  const root = join(cwd, harness === 'claude-code' ? '.claude' : '.agents', 'skills')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) { if (isEnoent(error)) return []; throw error }
  return Promise.all(entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    .map(async (entry) => ({ name: entry.name, hash: await skillContentHash(join(root, entry.name)) })))
}

export async function recordRecipe(host: HarnessHost, node: AgentNodeDef, cwd: string, selector: HarnessSelector, lessons: string[], prompt?: string): Promise<void> {
  const { stores, profiles } = host.deps
  const events = await stores.events.read(host.state.runId, { nodeId: node.id })
  const start = events.map((event) => event.type).lastIndexOf('node.started')
  if (events.slice(start + 1).some((event) => event.type === 'node.recipe' && (event.data as NodeRecipe).role === node.role && (event.data as NodeRecipe).harness === selector.harness && (event.data as NodeRecipe).model === selector.model)) return
  const snapshot = await stores.runs.getWorkflow(host.state.runId)
  const definition = snapshotNodes([...(snapshot?.nodes ?? []), ...host.state.expansions.flatMap((item) => item.nodes ?? [])]).find((item) => item.id === node.id)
  const original = host.graph?.get(node.id)?.def
  let template: string | AgentNodeDef['prompt'] = node.prompt
  if (original && 'prompt' in original) template = original.prompt
  if (original?.kind === 'review') {
    const reviewer = [...original.reviewers, ...(original.arbiter ? [original.arbiter] : [])].find((item) => item.role === node.role)
    template = node.role === original.author.role ? original.author.prompt ?? '按评审意见修改产物'
      : canonicalJson({ focus: reviewer?.focus, checklist: reviewer?.checklist, target: original.target, role: node.role })
  }
  if (original?.kind === 'judge') template = canonicalJson({ template: '判断以下失败的根因。输出 { verdicts: JudgeVerdict[] }，每个 subject 恰好一个判决：', target: original.target, routes: original.routes })
  if (original?.kind === 'gate') template = canonicalJson(original.checks.filter((check) => check.kind === 'rubric' && check.role === node.role))
  const profile = await readFileIfExists(join(stores.paths.agents, `${node.role}.md`))
  const value: Omit<NodeRecipe, 'recipeKey'> = {
    workflowId: host.state.workflowId, workflowVersion: host.state.workflowVersion,
    ...(typeof host.state.args.workflowRev === 'string' ? { workflowRev: host.state.args.workflowRev } : {}),
    nodeId: node.id, kind: original?.kind ?? definition?.kind ?? node.kind, role: node.role,
    profileHash: sha256(profile ?? canonicalJson(profiles[node.role])),
    promptHash: sha256(typeof template === 'function' ? template.toString() : template),
    skills: await loadedSkills(cwd, selector.harness), harness: selector.harness, model: selector.model, effort: selector.effort, lessons,
  }
  await host.emit('node.recipe', { ...value, recipeKey: recipeKey(value) }, node.id)
  await host.emit('log', recipeInputsLog(host.state.nodes[node.id]?.inputs ?? [], prompt, node.resultSchema), node.id)
}
