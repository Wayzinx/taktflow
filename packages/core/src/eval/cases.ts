import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { EvalCollectRequest } from '../api.js'
import type { Defect, DefectAttribution, EvalCase, EvalTarget, EventPayloads, RunState } from '../types.js'
import { readReviewRounds } from '../insights/review-rounds.js'
import { readRecipeContext, readRecipeInputs, type FrozenNode } from '../engine/recipe-record.js'
import { snapshotNodes } from '../engine/recipe.js'
import { assertArtifactPath } from '../store/paths.js'
import { assertNoSymlinks, isEnoent } from '../store/fs-utils.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { evalId, evalRoot, jsonFiles, targetName } from './storage.js'
import { appendEvalObject, evalView, qualityStore, type EvalWriteOptions } from './quality-access.js'
import { checkpointCase, confirmedMiss, replaySource } from './samples.js'

export function validateEvalCase(value: EvalCase): void {
  evalId(value.id); targetName(value.target)
  if (!value.node || !Array.isArray(value.inputs) || !value.grading || !value.source) throw new Error('评测用例缺少 node / inputs / grading / source')
  for (const input of value.inputs) { assertArtifactPath(input.path); if (typeof input.content !== 'string') throw new Error('冻结输入必须包含内容') }
  for (const output of value.node.outputs ?? []) assertArtifactPath(output.path)
  if (value.sample) {
    if (!['must_catch', 'clean'].includes(value.sample.kind) || !value.sample.checkpointId?.trim()) throw new Error('检查点样本分类或身份无效；请重新创建样本')
    assertArtifactPath(value.sample.snapshot)
    if (value.sample.kind === 'must_catch' && !value.sample.expectIssue?.trim()) throw new Error('必须拦住样本缺少期望问题；请填写 expectIssue')
  }
  for (const key of ['checks', 'commands', 'mustFind', 'mustNotIntroduce'] as const) {
    const values = value.grading[key]
    if (values !== undefined && (!Array.isArray(values) || values.some((item) => typeof item !== 'string' || !item.trim()))) throw new Error(`grading.${key} 必须是非空字符串数组`)
  }
  if (value.grading.rubric && (!Number.isFinite(value.grading.rubric.threshold) || value.grading.rubric.threshold < 0 || value.grading.rubric.threshold > 100 || !value.grading.rubric.text)) throw new Error('rubric 阈值必须在 0–100 之间')
}
export async function saveEvalCase(stores: ProjectStores, value: EvalCase, options: EvalWriteOptions = {}): Promise<boolean> {
  validateEvalCase(value)
  if (value.sample?.kind === 'clean') throw new Error('无缺陷样本需要人工确认；请通过 addEvalSample 创建')
  return appendEvalObject(stores, 'sample.added', value, { reason: '保存冻结评测用例', ...options })
}
export async function listEvalCases(stores: ProjectStores, target?: EvalTarget, options: { includeRetired?: boolean } = {}): Promise<EvalCase[]> {
  const root = evalRoot(stores)
  let entries: Dirent[]
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) { if (!isEnoent(error)) throw error; entries = [] }
  const cases: EvalCase[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'runs') continue
    await assertNoSymlinks(root, join(root, entry.name))
    cases.push(...await jsonFiles<EvalCase>(join(root, entry.name)))
  }
  let skills: Dirent[]
  try { skills = await readdir(stores.paths.skills, { withFileTypes: true }) } catch (error) { if (!isEnoent(error)) throw error; skills = [] }
  for (const skill of skills) {
    if (!skill.isDirectory() || target?.kind === 'skill' && skill.name !== target.name) continue
    const dir = join(stores.paths.skills, skill.name, 'evals')
    await assertNoSymlinks(stores.paths.skills, dir)
    for (const value of await jsonFiles<EvalCase>(dir)) cases.push({ ...value, target: { kind: 'skill', name: skill.name }, source: { ...value.source, kind: 'skill' } })
  }
  const persisted = await evalView<EvalCase>(stores, 'samples')
  const known = new Set(persisted.map(value => value.id))
  const legacyIds = new Map<string, EvalCase>()
  for (const value of cases) {
    const previous = legacyIds.get(value.id)
    if (previous && canonicalJson(previous) !== canonicalJson(value)) throw new Error(`旧评测用例 id 冲突：${value.id}；请为不同用例分配唯一 id`)
    legacyIds.set(value.id, value)
    const current = persisted.find(row => row.id === value.id)
    if (current && targetName(current.target) !== targetName(value.target)) throw new Error(`评测用例 id 跨目标冲突：${value.id}；请为不同目标分配唯一 id`)
  }
  for (const value of cases) if (!known.has(value.id)) {
    await saveEvalCase(stores, value, { reason: '导入旧评测或技能自带用例；仅可读取，执行仍需检查点隔离校验' })
    known.add(value.id)
  }
  const found = (await evalView<EvalCase>(stores, 'samples')).filter(value => options.includeRetired || !value.sample?.retiredAt).filter((value) => !target || targetName(value.target) === targetName(target))
  const ids = new Set<string>()
  for (const value of found) {
    validateEvalCase(value)
    const key = `${targetName(value.target)}:${value.id}`
    if (ids.has(key)) throw new Error(`评测用例重复：${key}`)
    ids.add(key)
  }
  return found
}

export async function freezeNode(stores: ProjectStores, run: RunState, nodeId: string): Promise<Pick<EvalCase, 'node' | 'inputs' | 'prompt'>> {
  const snapshot = await stores.runs.getWorkflow(run.runId)
  const node = snapshotNodes([...(snapshot?.nodes ?? []), ...run.expansions.flatMap((entry) => entry.nodes ?? [])]).find((entry) => entry.id === nodeId)
  if (!node) throw new Error(`找不到节点定义：${run.runId}/${nodeId}`)
  const events = await stores.events.read(run.runId, { nodeId })
  const prompt = events.find((e) => e.type === 'harness.message' && (e.data as EventPayloads['harness.message']).role === 'user')?.data as EventPayloads['harness.message'] | undefined
  const inputs: EvalCase['inputs'] = []
  // 产物最早版本的溯源保存了首次执行的输入；状态里的 inputs 可能已被重做覆盖。
  const artifacts = await stores.workspaces.listArtifacts(run.requirementId)
  const version = artifacts.flatMap((artifact) => artifact.versions).filter((v) => v.producedBy?.runId === run.runId && v.producedBy.nodeId === nodeId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  const recorded = readRecipeInputs(events)
  for (const ref of recorded?.refs ?? version?.derivedFrom ?? run.nodes[nodeId]?.inputs ?? []) {
    if (ref.version === undefined) throw new Error(`输入未冻结版本：${ref.path}`)
    const content = await stores.workspaces.readArtifact(ref)
    if (!content) throw new Error(`冻结输入不存在：${ref.path}@${ref.version}`)
    inputs.push({ path: ref.path, content: content.toString(), kind: artifacts.find((a) => a.path === ref.path)?.kind })
  }
  const context = await readRecipeContext(stores, run.runId, nodeId, events) ?? recorded
  const template = context?.prompt ?? node.prompt
  const frozen: FrozenNode = { ...structuredClone(node), resultSchema: context?.resultSchema, replayPromptKind: template === undefined ? 'assembled-legacy' : 'template' }
  return { node: frozen, inputs, prompt: template ?? prompt?.text }
}

export async function defectCases(stores: ProjectStores, defect: Defect, attribution: DefectAttribution): Promise<EvalCase[]> {
  const cases: EvalCase[] = []
  for (const item of attribution.checkpoints ?? []) {
    if (!confirmedMiss(defect, attribution, item.checkpointId)) continue
    const source = await replaySource(stores, item.checkpointId, item.runId, item.nodeId)
    if (source.run.requirementId !== defect.requirementId) throw new Error('缺陷与检查点不属于同一需求；请核对归因')
    cases.push(await checkpointCase(stores, source, 'must_catch', defect))
  }
  return cases
}

export async function collectCases(stores: ProjectStores, request: EvalCollectRequest): Promise<{ added: string[] }> {
  const added: string[] = []
  const accept = async (value: EvalCase) => {
    if (request.target && targetName(value.target) !== targetName(request.target)) return
    if ((await evalView<EvalCase>(stores, 'samples')).some(row => row.id === value.id)) return
    if (await saveEvalCase(stores, value)) added.push(value.id)
  }
  for (const run of await stores.runs.list()) {
    if (request.runIds && !request.runIds.includes(run.runId)) continue
    const events = await stores.events.read(run.runId)
    const artifacts = await stores.workspaces.listArtifacts(run.requirementId)
    const reviewRounds = await readReviewRounds({ store: stores.workspaces, requirementId: run.requirementId }, new Set([run.runId]))
    const humanReferences = new Map<string, import('../types.js').ArtifactRef>()
    const snapshot = await stores.runs.getWorkflow(run.runId)
    const agents = new Set(snapshotNodes([...(snapshot?.nodes ?? []), ...run.expansions.flatMap((entry) => entry.nodes ?? [])]).filter((node) => node.kind === 'agent').map((node) => node.id))
    const candidates = new Set(events.filter((e) => e.type === 'rework.started').map((e) => (e.data as EventPayloads['rework.started']).to))
    for (const entry of reviewRounds) if (!entry.round.passed) for (const record of entry.round.records) for (const ref of record.artifacts) {
      const producer = artifacts.find((artifact) => artifact.path === ref.path)?.versions.find((version) => version.version === ref.version)?.producedBy
      if (producer?.runId === run.runId) candidates.add(producer.nodeId)
    }
    for (const event of events) {
      if (event.type === 'review.round' && !(event.data as EventPayloads['review.round']).passed) {
        for (const ref of run.nodes[event.nodeId!]?.inputs ?? []) {
          const producer = artifacts.find((a) => a.path === ref.path)?.versions.find((v) => v.version === ref.version)?.producedBy
          if (producer?.runId === run.runId) candidates.add(producer.nodeId)
        }
      }
      if (event.type !== 'artifact.edited' || event.actor.type !== 'human') continue
      const edit = event.data as EventPayloads['artifact.edited']
      if (edit.impact === 'cosmetic') continue
      const artifact = artifacts.find((a) => a.path === edit.ref.path)
      const producer = artifact?.versions.filter((v) => v.version < (edit.ref.version ?? Infinity) && v.producedBy?.runId === run.runId).at(-1)?.producedBy
      if (producer) { candidates.add(producer.nodeId); humanReferences.set(producer.nodeId, edit.ref) }
    }
    // 有些人工修改没有下游失效事件；产物版本中的 human 作者仍是可审计来源。
    for (const artifact of artifacts) for (const version of artifact.versions) {
      if (version.author.type !== 'human') continue
      const edits = events.filter((event) => event.type === 'artifact.edited').map((event) => event.data as EventPayloads['artifact.edited'])
        .filter((edit) => edit.ref.path === artifact.path && edit.ref.version === version.version)
      if (edits.length && edits.every((edit) => edit.impact === 'cosmetic')) continue
      const source = artifact.versions.filter((previous) => previous.version < version.version && previous.producedBy
        && (previous.producedBy.runId !== run.runId || agents.has(previous.producedBy.nodeId))).at(-1)?.producedBy
      if (source?.runId !== run.runId) continue
      candidates.add(source.nodeId)
      humanReferences.set(source.nodeId, { workspace: run.requirementId, path: artifact.path, version: version.version })
    }
    for (const nodeId of candidates) {
      if (!events.some((event) => event.nodeId === nodeId && event.type === 'node.finished' && (event.data as EventPayloads['node.finished']).status === 'succeeded')) continue
      const frozen = await freezeNode(stores, run, nodeId)
      if (frozen.node.kind !== 'agent') continue
      const produced = run.nodes[nodeId]?.outputs ?? []
      const reviewed = reviewRounds.flatMap((entry) => entry.round.passed ? entry.round.records.flatMap((record) => record.artifacts) : [])
        .filter((ref) => produced.some((output) => output.path === ref.path)).sort((a, b) => (a.version ?? 0) - (b.version ?? 0)).at(-1)
      const output = humanReferences.get(nodeId) ?? reviewed
      if (!output || output.version === undefined) continue
      const content = await stores.workspaces.readArtifact(output)
      if (!content) throw new Error(`参考答案版本不存在：${output.path}@${output.version}`)
      await accept({ ...frozen, id: `history-${sha256(`${run.runId}/${nodeId}`).slice(0, 20)}`, title: frozen.node.title,
        target: { kind: 'node', workflowId: run.workflowId, nodeId }, source: { kind: 'history', runId: run.runId, nodeId },
        grading: { checks: frozen.node.completion, reference: { path: output.path, content: content.toString() } }, createdAt: run.endedAt ?? run.startedAt })
    }
  }
  if (request.includeDefects) for (const defect of await qualityStore(stores).defects()) {
    if (defect.attribution) for (const value of await defectCases(stores, defect, defect.attribution)) await accept(value)
  }
  return { added }
}
