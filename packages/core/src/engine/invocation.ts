import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Actor, AgentNodeDef, HarnessAdapter, HarnessRequest, HarnessSelector, KnowledgeHit, NodeState } from '../types.js'
import type { Recipe } from '../quality.js'
import type { CaptureContext, CapturedInputSnapshot, CapturedInvocation, ResultInput } from './capture-types.js'
import type { HarnessHost } from './harness.js'
import type { PromptParams } from './prompt-renderer.js'
import { RENDERER_VERSION } from './prompt-renderer.js'
import { captureAssets, assetRef } from './capture-assets.js'
import { captureRedactor } from './capture-redaction.js'
import { putObject } from '../store/objects.js'
import { canonicalJson, sha256 } from '../util/hash.js'

type Assets = Awaited<ReturnType<typeof captureAssets>>
export type Redactor = Awaited<ReturnType<typeof captureRedactor>>

export function effectiveOverrides(host: HarnessHost, harness: HarnessAdapter) {
  const declared = host.capture?.adapters?.[harness.id]
  const cli = host.deps.stores.config.harnesses?.find((entry) => entry.id === harness.id)
  const capabilities = harness.capabilities as (HarnessAdapter['capabilities'] & { modelOverride?: boolean; effortOverride?: boolean })
  const model = declared?.model ?? capabilities?.modelOverride ?? (harness.id === 'dsh' ? false : cli ? Boolean(cli.model?.flag || cli.model?.env || cli.command.some((part) => part.includes('{{model}}'))) : ['native', 'codex', 'claude-code'].includes(harness.id) ? true : undefined)
  const effort = declared?.effort ?? capabilities?.effortOverride ?? (harness.id === 'dsh' || cli ? false : harness.id === 'codex' ? true : ['native', 'claude-code'].includes(harness.id) ? false : undefined)
  return { model, effort }
}

export async function startInvocation(host: HarnessHost, node: AgentNodeDef, ns: NodeState, actor: Actor, request: HarnessRequest,
  selector: HarnessSelector, fallbackIndex: number, harness: HarnessAdapter, context: CaptureContext, assets: Assets,
  template: string, params: PromptParams, knowledge: KnowledgeHit[], results: ResultInput[], redact: Redactor): Promise<CapturedInvocation> {
  const stores = host.deps.stores
  const put = async (content: string) => (host.capture?.putObject ?? putObject)(stores, redact.text(content))
  const notes = [...assets.notes, ...(context.replayNotes ?? [])]
  if (!host.workflowSource) notes.push('加载入口未提供 workflow 源码与依赖闭包身份')
  if (typeof node.prompt === 'function' && !context.render) notes.push('动态 prompt 只冻结本次求值结果，不支持替换模板逻辑')
  if (request.sessionId) notes.push('续聊历史未完全冻结')
  if (!host.capture?.adapters?.[harness.id]?.version) notes.push('适配器版本 unknown')
  if (!context.snapshotDir && ns.inputs?.length) notes.push('普通节点输入未物化为只读目录，冻结的是调用前登记版本')
  if (request.tools?.allowBash || request.sandbox?.spec.network !== 'none') notes.push('工具和外部环境未冻结；只保证交给 harness 的请求，非模型最终输入')
  const support = effectiveOverrides(host, harness)
  for (const name of ['model', 'effort'] as const) if (selector[name] && support[name] !== true) notes.push(`${name} ${support[name] === false ? '未生效：适配器不支持覆盖' : '覆盖是否生效 unknown：适配器未声明'}`)
  const staticRecipe: Omit<Recipe, 'recipeId'> = redact.value({
    role: node.role, profile: assetRef(assets.role), skills: assets.declared.map(assetRef), template: assetRef(assets.template),
    harness: selector.harness, provider: selector.provider, model: selector.model, effort: selector.effort,
    outputSchema: node.resultSchema ? sha256(canonicalJson(node.resultSchema)) : undefined,
  })
  const recipe: Recipe = { ...staticRecipe, recipeId: sha256(canonicalJson(staticRecipe)) }
  const inputs: CapturedInputSnapshot['inputs'] = []
  for (const item of context.materials ?? (ns.inputs ?? []).map((ref) => ({ ref, role: 'input' as const }))) {
    const bytes = await stores.workspaces.readArtifact(item.ref)
    const record = (await stores.workspaces.listArtifacts(item.ref.workspace)).find((artifact) => artifact.path === item.ref.path)
    const version = record?.versions.find((version) => version.version === item.ref.version)
    if (!bytes || !version || sha256(bytes) !== version.sha256) throw new Error(`输入版本 hash 不一致：${item.ref.path}`)
    if (context.snapshotDir && sha256(await readFile(join(context.snapshotDir, item.ref.path))) !== version.sha256) throw new Error(`快照与输入版本不一致：${item.ref.path}`)
    inputs.push({ ...item, sha256: version.sha256, object: await put(bytes.toString('utf8')) })
  }
  const renderAssets = []
  for (const value of [...new Map([...assets.declared, ...assets.provided, assets.role, assets.template, ...(assets.duty ? [assets.duty] : [])].map((asset) => [asset.id, asset])).values()]) renderAssets.push({ ...assetRef(value), object: await put(value.content) })
  const snapshot: Omit<CapturedInputSnapshot, 'inputSnapshotId'> = {
    request: { prompt: await put(request.prompt), systemAppend: request.systemAppend === undefined ? undefined : await put(request.systemAppend), schema: request.resultSchema ? await put(canonicalJson(request.resultSchema)) : undefined },
    inputs, knowledge: await Promise.all(knowledge.map(async (hit) => ({ source: hit.sourceId, ref: hit.ref, object: await put(hit.snippet) }))),
    skillsProvided: assets.provided.map(assetRef),
    skillUse: [...assets.declared.map((asset) => ({ asset: assetRef(asset), declared: true, provided: false, loaded: 'unknown' as const })),
      ...assets.provided.map((asset) => ({ asset: assetRef(asset), declared: false, provided: true, loaded: 'unknown' as const }))],
    results: await Promise.all(results.map(async ({ from, value }) => ({ from, object: await put(canonicalJson(value ?? null)) }))),
    workflow: host.workflowSource,
    cwdLayout: { root: request.cwd, paths: { workspace: params.workspace, ...(context.snapshotDir ? { snapshot: context.snapshotDir } : {}) } },
    render: { rendererVersion: RENDERER_VERSION, template: { kind: context.render?.kind ?? 'node-prompt', object: await put(template) }, params: await put(canonicalJson(params)), assets: renderAssets,
      exec: { adapter: harness.id, adapterVersion: host.capture?.adapters?.[harness.id]?.version ?? 'unknown',
        tools: host.capture?.adapters?.[harness.id]?.tools ?? (harness.id === 'native' ? ['read_file', 'write_file', 'edit_file', 'list', 'grep', ...(request.tools?.allowBash ? ['unknown'] : [])] : ['unknown']),
        permissions: canonicalJson({ ...request.tools, sandbox: request.sandbox?.provider ?? 'unknown', readOnlyMaterials: Boolean(context.snapshotDir) }), env: Object.keys(request.env ?? {}).sort() } },
    redactions: 0,
  }
  // 只对落盘值计算 ID，避免 undefined、脱敏或键顺序造成读回 hash 不一致。
  const safeSnapshot = redact.value(snapshot)
  safeSnapshot.redactions = redact.redactions + (host.workflowSource?.redactions ?? 0)
  const inputSnapshot: CapturedInputSnapshot = { ...safeSnapshot, inputSnapshotId: sha256(canonicalJson(safeSnapshot)) }
  if (inputSnapshot.redactions) notes.push('脱敏改写了采集内容')
  const invocation: CapturedInvocation = {
    invocationId: '', runId: host.state.runId, nodeId: node.id, attempt: ns.attempts, iteration: ns.iteration,
    review: context.review, checkpointId: context.checkpoint?.checkpointId, gateCheckId: context.gateCheckId, fallbackIndex,
    recipeId: recipe.recipeId, inputSnapshotId: inputSnapshot.inputSnapshotId,
    requested: redact.value({ harness: selector.harness, provider: selector.provider, model: selector.model, effort: selector.effort }),
    resolved: redact.value({ harness: harness.id, model: support.model === false ? undefined : request.model, effort: support.effort === false ? undefined : request.effort }),
    effective: { model: selector.model === undefined || support.model === undefined ? 'unknown' : support.model ? 'applied' : 'unsupported', effort: selector.effort === undefined || support.effort === undefined ? 'unknown' : support.effort ? 'applied' : 'unsupported' },
    replay: notes.length ? 'limited' : 'full', replayNotes: notes,
  }
  await host.emit('invocation.started', { invocation, recipe, inputSnapshot }, node.id, actor)
  return invocation
}
