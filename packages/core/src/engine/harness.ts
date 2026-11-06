import { mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { EngineDeps } from '../interfaces.js'
import type { Actor, AgentNodeDef, ContextItem, EventPayloads, EventType, HarnessEvent, HarnessRequest, HarnessResult, NodeContext, NodeState, RunState } from '../types.js'
import { estimateTokens } from '../util/tokens.js'
import { addUsage } from '../insights/usage.js'
import { assertNoSymlinks } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import { createKnowledgeRouter } from '../knowledge/router.js'
import { parseResult, validateSchema } from './schema.js'
import { Semaphore } from './process.js'
import { system } from './actor.js'
import { WriteGuard } from './guard.js'
import { harnessSelectors, resolveHarnessSelector, selectHarness } from './selection.js'
import { intersectWriteScopes } from './scope.js'
import { workingDirectory, sandboxCall, cwdGuard, saveWorktreeDiff } from './execution.js'
import type { CaptureContext, CaptureOptions, CapturedInputSnapshot, ResultInput } from './capture-types.js'
import { captureAssets } from './capture-assets.js'
import { captureRedactor } from './capture-redaction.js'
import { effectiveOverrides, startInvocation } from './invocation.js'
import { collectOutputs } from './artifacts.js'
import { renderRequest, type PromptParams } from './prompt-renderer.js'

export class BlockedError extends Error {}
export type Emit = <T extends EventType>(type: T, data: EventPayloads[T], nodeId?: string, actor?: Actor) => Promise<void>
export interface HarnessHost {
  deps: EngineDeps
  state: RunState
  emit: Emit
  save(): Promise<void>
  signal: AbortSignal
  timestamp(): string
  semaphore: Semaphore
  guard: WriteGuard
  override?: string
  capture?: CaptureOptions
  workflowSource?: CapturedInputSnapshot['workflow']
  resultInputs?: Map<string, ResultInput[]>
}

export async function callHarness(host: HarnessHost, node: AgentNodeDef, ctx: NodeContext, ns: NodeState, acquireSlot = true, directories: string[] = [], capture: CaptureContext = {}): Promise<{ data: unknown; actor: Actor; invocationId: string }> {
  const invoke = async (): Promise<{ data: unknown; actor: Actor; invocationId: string }> => {
    host.signal.throwIfAborted()
    const { stores, profiles, harnesses, knowledge } = host.deps
    const profile = profiles[node.role]
    if (!profile) throw new Error(`角色不存在：${node.role}`)
    const cwd = await workingDirectory(host, node, ctx, ns)
    ctx = { ...ctx, projectDir: cwd }
    const selection = { config: stores.config, profiles, harnesses }
    const base = selectHarness(node.role, node.harness, selection, host.override)
    const task = typeof node.prompt === 'function' ? await node.prompt(ctx) : node.prompt
    const retryNote = [ns.error ? `上一次失败原因：${ns.error}` : '', ctx.feedback ? `上一次评审未通过，意见如下：${ctx.feedback}` : ''].filter(Boolean).join('\n')
    const items: ContextItem[] = []
    const add = (source: ContextItem['source'], title: string, text: string, ref?: string) => {
      items.push({ id: `${source}-${items.length}`, source, title, ref, tokens: estimateTokens(text), included: true })
    }
    add('role', profile.title, profile.instructions)
    add('prompt', node.title, [task, retryNote].filter(Boolean).join('\n'))
    for (const input of ns.inputs ?? []) {
      const text = await ctx.readArtifact(input.path)
      add('artifact', input.path, text ?? '', input.path)
    }
    const summaries: string[] = []
    const knowledgeHits: import('../types.js').KnowledgeHit[] = []
    for (const query of node.knowledge ?? []) {
      const { hits, sources } = await createKnowledgeRouter(knowledge).query(query)
      await host.emit('knowledge.query', { query, sources, hits: hits.length }, node.id)
      knowledgeHits.push(...hits)
      for (const hit of hits) { add('knowledge', hit.title, hit.snippet, hit.ref); summaries.push(`${hit.ref}: ${hit.snippet}`) }
    }
    const context = { nodeId: node.id, at: host.timestamp(), budgetTokens: stores.config.contextBudgetTokens ?? 200000, totalTokens: items.reduce((sum, item) => sum + item.tokens, 0), items }
    await stores.runs.saveContext(host.state.runId, context)
    await host.emit('context.assembled', context, node.id)
    const priorOutputs = ns.outputs.length || node.session !== 'resume' ? ns.outputs
      : ((await stores.events.read(host.state.runId, { nodeId: node.id, types: ['node.finished'] })).at(-1)?.data as EventPayloads['node.finished'] | undefined)?.outputs ?? []
    const chain = harnessSelectors(base)
    let previous = ''
    for (const [index, selector] of chain.entries()) {
      host.signal.throwIfAborted()
      if (index) await host.emit('log', { level: 'warn', message: `切换 harness → ${selector.harness}：${previous}` }, node.id)
      const { harness, model, provider, modelConfig } = resolveHarnessSelector(selector, stores.config, harnesses)
      const available = await harness.available().catch((error: unknown) => ({ ok: false, reason: String(error) }))
      if (!available.ok) { previous = available.reason ?? `${selector.harness} unavailable`; continue }
      const resume = node.session === 'resume' && harness.capabilities?.resume
      const history = node.session === 'resume' && !resume
        ? `该 harness 不支持续聊，本次使用新会话。上一轮产物清单：\n${priorOutputs.length ? priorOutputs.map((ref) => `${ref.workspace}/${ref.path} (version ${ref.version ?? 'latest'})`).join('\n') : '（无已登记产物）'}` : ''
      let requestPrompt = ''
      if (history) {
        const historyItem: ContextItem = { id: `history-${index}`, source: 'history', title: '上一轮产物清单', tokens: estimateTokens(history), included: true }
        const resumedContext = { ...context, at: host.timestamp(), items: [...items, historyItem], totalTokens: context.totalTokens + historyItem.tokens }
        await stores.runs.saveContext(host.state.runId, resumedContext)
        await host.emit('context.assembled', resumedContext, node.id)
      }
      const writeScope = intersectWriteScopes(profile.writeScope, node.writeScope)
      delete ns.usage
      const actor: Actor = { type: 'agent', role: node.role, harness: harness.id, model: effectiveOverrides(host, harness).model === false ? undefined : model }
      const transcript = join(runDir(stores.taktDir, host.state.runId), 'transcripts', `${node.id}.jsonl`)
      await assertNoSymlinks(stores.taktDir, transcript)
      await mkdir(dirname(transcript), { recursive: true })
      const env: Record<string, string> = { TAKT_ROLE: node.role, TAKT_NODE: node.id, TAKT_WORKSPACE: ctx.workspaceDir, TAKT_RUN_ID: host.state.runId, TAKT_REQ: ctx.requirementId, TAKT_TRANSCRIPT: transcript }
      if (provider?.apiKeyEnv && process.env[provider.apiKeyEnv]) env[provider.apiKeyEnv] = process.env[provider.apiKeyEnv]!
      const sandbox = await sandboxCall(host, cwd, harness.id, ctx, env, node.timeoutMs, directories, capture.snapshotDir)
      try {
        const template = capture.render?.template ?? '{{text}}'
        const assets = await captureAssets(host, profile, cwd, harness.id, capture, template, typeof node.prompt === 'function' ? node.prompt.toString() : node.prompt)
        const params: PromptParams = {
          task: capture.render?.params ?? { text: task }, knowledge: summaries, workspace: ctx.workspaceDir,
          inputs: (ns.inputs ?? []).map((input) => capture.snapshotDir ? join(capture.snapshotDir, input.path) : input.path),
          outputs: capture.review?.part === 'reviewer' ? [] : (node.outputs ?? []).map((output) => output.path),
          profileScope: profile.writeScope, nodeScope: node.writeScope ?? profile.writeScope, schema: node.resultSchema, retryNote, history,
          profile: assets.role.id, duty: capture.render?.duty?.id, suffix: capture.render?.suffix, skills: assets.provided.filter((asset) => profile.skills.some((name) => asset.id.endsWith('/' + name))).map((asset) => asset.id),
        }
        const rendered = renderRequest(template, params, [assets.role, assets.template, ...(assets.duty ? [assets.duty] : []), ...assets.provided])
        requestPrompt = rendered.prompt
        const support = effectiveOverrides(host, harness)
        const request: HarnessRequest = { prompt: requestPrompt, cwd, sandbox, model: support.model === false ? undefined : model,
          effort: support.effort === false ? undefined : selector.effort, provider,
          modelConfig: modelConfig ? { price: modelConfig.price, contextWindow: modelConfig.contextWindow } : undefined,
          systemAppend: rendered.systemAppend, timeoutMs: node.timeoutMs, resultSchema: harness.capabilities?.structuredOutput ? node.resultSchema : undefined,
          sessionId: resume && ns.sessionRef?.harness === harness.id ? ns.sessionRef.sessionId : undefined, env,
          tools: { writeScope, allowBash: profile.allowBash === true },
          signal: node.timeoutMs ? AbortSignal.any([host.signal, AbortSignal.timeout(node.timeoutMs)]) : host.signal,
        }
        const redact = await captureRedactor(request, stores.config.providers)
        let finishGuard: () => Promise<{ paths: string[]; action: 'flagged'; ambiguous: boolean }>
        const scope = { profile: profile.writeScope, node: node.writeScope }
        const projectFinish = await host.guard.begin(scope)
        const finishes = [projectFinish]
        try {
          for (const directory of new Set([cwd, ...directories])) {
            if (directory !== stores.projectDir) finishes.push(await cwdGuard(host, directory).begin(scope))
          }
        } catch (error) { await Promise.all(finishes.map((finish) => finish())); throw error }
        finishGuard = async () => {
          const violations = await Promise.all(finishes.map((finish) => finish()))
          return { paths: [...new Set(violations.flatMap((violation) => violation.paths))], action: 'flagged', ambiguous: violations.some((violation) => violation.ambiguous) }
        }
        let eventChain = Promise.resolve()
        const reported: { model?: string; sessionId?: string } = {}
        const loadedSkills = new Set<string>()
        let eventError: unknown
        const onEvent = (raw: HarnessEvent): void => {
          const event = redact.value(raw)
          if (event.type === 'started') {
            if (event.model !== undefined) reported.model = event.model
            if (event.sessionId !== undefined) reported.sessionId = event.sessionId
          }
          if (event.type === 'tool_call' && /(?:^|[-_.])skill(?:$|[-_.])|^Skill$/.test(event.tool) && event.ok === true) {
            try {
              const input = JSON.parse(event.input) as { name?: string; skill?: string }
              const name = input.name ?? input.skill
              if (name) for (const skill of assets.provided) if (skill.id.endsWith('/' + name)) loadedSkills.add(skill.id)
            } catch { /* 不把无法识别的工具调用冒充加载证明。 */ }
          }
          eventChain = eventChain.then(async () => {
            if (event.type === 'started') {
              if (event.sessionId) ns.sessionRef = { harness: harness.id, sessionId: event.sessionId }
              await host.emit('harness.started', { harness: harness.id, model: event.model, sessionId: event.sessionId }, node.id, actor)
            } else if (event.type === 'usage') {
              if (harness.capabilities?.usage) {
                ns.usage = addUsage(ns.usage ?? { inputTokens: 0, outputTokens: 0 }, event.usage)
                await host.emit('harness.usage', event.usage, node.id, actor)
              }
            } else if (event.type === 'compacted') {
              const record = { ...event.record, nodeId: node.id }
              await stores.runs.saveCompaction(host.state.runId, record)
              await host.emit('context.compacted', record, node.id, actor)
            } else if (event.type === 'message') {
              await host.emit('harness.message', { role: event.role, text: event.text }, node.id, actor)
            } else {
              await host.emit('harness.tool_call', { tool: event.tool, input: event.input, output: event.output, ok: event.ok }, node.id, actor)
            }
          }).catch((error: unknown) => { eventError ??= error })
        }
        let result: HarnessResult | undefined
        let failure: unknown
        let invocation: Awaited<ReturnType<typeof startInvocation>> | undefined
        try {
          await host.emit('harness.message', { role: 'user', text: redact.text(requestPrompt) }, node.id, actor)
          request.signal?.throwIfAborted()
          invocation = await startInvocation(host, node, ns, actor, request, selector, index, harness, capture, assets, template, params,
            knowledgeHits, host.resultInputs?.get(node.id) ?? [], redact)
          result = redact.value(await harness.run(request, onEvent))
        } catch (error) { failure = error }
        finally {
          await eventChain
          if (invocation) {
            const error = failure instanceof Error ? failure.message : String(failure ?? result?.error ?? 'harness failed')
            const outcome = { status: request.signal?.aborted ? 'cancelled' as const : failure || !result?.ok ? 'error' as const : 'ok' as const,
              usage: result?.usage ?? ns.usage, ...(failure || !result?.ok ? { error: redact.text(error) } : {}) }
            if (result?.sessionId) reported.sessionId = redact.text(result.sessionId)
            const finished = { invocationId: invocation.invocationId, outcome, reported,
              skills: assets.provided.map((asset) => ({ asset: asset.id, loaded: loadedSkills.has(asset.id) ? 'confirmed' : 'unknown' })),
              redactions: redact.redactions, replay: redact.redactions ? 'limited' : invocation.replay }
            try { await host.emit('invocation.finished', finished, node.id, actor) } catch (error) { failure ??= error }
          }
        }
        const violation = await finishGuard()
        await saveWorktreeDiff(host, node.id, ns)
        if (violation.paths.length) {
          await host.emit('guard.violation', { rule: violation.ambiguous ? 'concurrent-write' : 'writeScope', paths: violation.paths, action: violation.action }, node.id, violation.ambiguous ? system : actor)
          throw new BlockedError(`写权限越界：${violation.paths.join(', ')}`)
        }
        if (invocation && capture.review?.part !== 'reviewer') {
          const collectNode = failure || !result?.ok ? { ...node, outputs: node.outputs?.map((output) => ({ ...output, required: false, schema: undefined })) } : node
          const prefix = relative(stores.projectDir, stores.workspaces.dir(host.state.requirementId))
          await host.guard.system((node.outputs ?? []).map((output) => `${prefix}/${output.path}`), () => collectOutputs(stores, host.state, collectNode, ns, actor, host.emit, invocation!.invocationId))
        }
        host.signal.throwIfAborted()
        if (eventError) throw eventError
        if (failure || !result?.ok) {
          previous = failure instanceof Error ? failure.message : String(failure ?? result?.error ?? 'harness failed')
          previous = redact.text(previous)
          if (/429|503|401|sign in|timeout/i.test(previous) && index < chain.length - 1) continue
          throw new Error(previous)
        }
        if (result.sessionId) ns.sessionRef = { harness: harness.id, sessionId: result.sessionId }
        if (harness.capabilities?.usage && result.usage) ns.usage = result.usage
        if (!harness.capabilities?.usage || !ns.usage) {
          const inputTokens = estimateTokens(request.systemAppend ?? '') + estimateTokens(requestPrompt)
          const outputTokens = estimateTokens(result.finalText)
          const price = modelConfig?.price
          const estimated = { inputTokens, outputTokens, ...(price ? { costUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000 } : {}), note: 'estimated' }
          ns.usage = { inputTokens, outputTokens, ...(estimated.costUsd !== undefined ? { costUsd: estimated.costUsd } : {}) }
          await host.emit('harness.usage', estimated, node.id, actor)
        }
        await host.save()
        const data = result.structured !== undefined ? result.structured : node.resultSchema ? parseResult(result.finalText, node.resultSchema) : result.finalText
        if (node.resultSchema) validateSchema(data, node.resultSchema)
        return { data: redact.value(data), actor, invocationId: invocation!.invocationId }
      } finally { await sandbox.dispose() }
    }
    throw new Error(previous || '没有可用 harness')
  }
  return acquireSlot ? host.semaphore.use(invoke) : invoke()
}
