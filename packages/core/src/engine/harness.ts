import { resolveSecret } from '../secrets/index.js'
import { recordRecipe } from './recipe.js'
import { captureContext, type CaptureContext } from './checkpoints.js'
import { startInvocation } from './invocations.js'
import { snapshotPrompt } from './snapshots.js'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from '../store/fs-utils.js'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EngineDeps } from '../interfaces.js'
import type { Actor, AgentNodeDef, ContextItem, EventPayloads, EventType, HarnessEvent, HarnessRequest, HarnessResult, NodeContext, NodeDef, NodeState, RunState, InvocationEnd, ModelConfig, Usage } from '../types.js'
import { estimateTokens } from '../util/tokens.js'
import { addUsage } from '../insights/usage.js'
import { assertNoSymlinks } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import { createKnowledgeRouter } from '../knowledge/router.js'
import { runStructured } from './structured.js'
import { collectSecrets, createRedactor, redactValue } from '../util/redact.js'
import { Semaphore } from './process.js'
import { WriteGuard } from './guard.js'
import { harnessSelectors, resolveHarnessSelector, selectHarness } from './selection.js'
import { intersectWriteScopes } from './scope.js'
import { completionPrompt, completionSchema, checkCompletion, completionErrors, resultSummary } from './completion.js'
import { FailureError } from './fingerprint.js'
import { extractJsonBlock } from '../util/json-block.js'
import { workingDirectory, sandboxCall, cwdGuard, saveWorktreeDiff } from './execution.js'

export class BlockedError extends Error {}
export type Emit = <T extends EventType>(type: T, data: EventPayloads[T], nodeId?: string, actor?: Actor) => Promise<void>
export interface HarnessHost {
  deps: EngineDeps
  graph?: { get(id: string): { def: NodeDef } | undefined }
  state: RunState
  emit: Emit
  save(): Promise<void>
  signal: AbortSignal
  timestamp(): string
  semaphore: Semaphore
  guard: WriteGuard
  override?: string
  setLessonRecall?(nodeId: string, recalled: Awaited<ReturnType<NonNullable<EngineDeps['lessons']>['recall']>> | undefined): void
}

export async function callHarness(host: HarnessHost, node: AgentNodeDef, ctx: NodeContext, ns: NodeState, acquireSlot = true, directories: string[] = [], capture?: CaptureContext, validateOutput?: (data: unknown) => string[]): Promise<{ data: unknown; actor: Actor }> {
  const invoke = async (): Promise<{ data: unknown; actor: Actor }> => {
    host.signal.throwIfAborted()
    const identity = capture ?? captureContext(host, node.id) ?? { role: 'producer' }
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
    const skills = `技能清单：${profile.skills.join(', ') || '（无）'}`
    add('skill', '技能清单', skills)
    const summaries: string[] = []
    const declared = Array.isArray(node.knowledge) ? { prefetch: node.knowledge, mode: 'prefetch' as const } : node.knowledge
    const spec = declared || profile.knowledge !== undefined ? { ...declared, bases: declared?.bases ?? profile.knowledge } : undefined
    const prefetch = Array.isArray(node.knowledge) ? node.knowledge : node.knowledge?.mode === 'tool' ? [] : node.knowledge?.prefetch ?? []
    // 接上空的 KnowledgeStore 不代表已迁移；批准绑定之前仍使用旧知识源。
    const hasBindings = stores.kb && (await stores.kb.bindings()).length > 0
    for (const query of prefetch) {
      if (stores.kb && (hasBindings || spec?.bases !== undefined || query.bases !== undefined)) {
        const queryId = randomUUID()
        const result = await host.guard.system(['.takt/knowledge/queries.jsonl', '.takt/space-events.jsonl*'], () => stores.kb!.route(query, { bases: spec?.bases, caller: { queryId, runId: ctx.runId, nodeId: node.id, requirementId: ctx.requirementId, role: node.role, via: 'prefetch' } }))
        const file = join(runDir(stores.taktDir, ctx.runId), 'context/knowledge', `${queryId}.md`)
        await assertNoSymlinks(stores.taktDir, file)
        await writeFileAtomic(file, result.hits.map(hit => `## ${hit.title}\n${hit.ref}\n${hit.snippet}`).join('\n\n'))
        await host.emit('knowledge.query', { query, sources: result.bases.map(b => b.id), hits: result.hits.length, queryId, bases: result.bases, top: result.hits.map((h, i) => ({ baseId: h.baseId, ref: h.ref, score: h.score ?? 0, rank: i + 1 })), latencyMs: result.latencyMs, tokens: result.tokens, via: 'prefetch' }, node.id)
        add('knowledge', query.text, result.hits.map(h => h.snippet).join('\n'), file)
        summaries.push(`知识检索结果：${file}\n${result.hits.map(h => `${h.ref}: ${h.snippet}`).join('\n')}`)
      } else {
        const { hits, sources } = await createKnowledgeRouter(knowledge).query(query)
        await host.emit('knowledge.query', { query, sources, hits: hits.length }, node.id)
        for (const hit of hits) { add('knowledge', hit.title, hit.snippet, hit.ref); summaries.push(`${hit.ref}: ${hit.snippet}`) }
      }
    }
    let knowledgeTools = ''
    if (stores.kb && spec && spec.mode !== 'prefetch') {
      const bindings = await stores.kb.bindings()
      const bases = (await stores.kb.list()).filter(kb => kb.version && (!spec.bases || spec.bases.includes(kb.id)) && bindings.some(b => b.baseId === kb.id && b.enabled && (!b.roles || b.roles.includes(node.role))))
      knowledgeTools = `知识库：\n${bases.map(kb => `${kb.id} — ${kb.name}：${kb.description}；intents=${kb.intents.join(',')}`).join('\n')}\n按需查询：takt kb query "<问题>" --base <id> --project "${stores.projectDir}"`
      add('knowledge', '可用知识库', knowledgeTools)
    }

    const recalled = host.deps.lessons && await host.deps.lessons.recall({ runId: ctx.runId, nodeId: node.id, role: node.role,
      paths: [...(node.writeScope ?? profile.writeScope), ...(node.inputs ?? []).map((input) => input.path)], feedback: [ctx.feedback, ns.error].filter(Boolean).join('\n') || undefined })
    if (node.kind === 'agent' && host.setLessonRecall) host.setLessonRecall(node.id, recalled)
    const lessonText = recalled && !recalled.holdout && recalled.text ? `经验：\n${recalled.text}` : ''
    if (lessonText) add('lesson', '经验', lessonText)
    if (recalled?.lessons.length) await host.emit('lesson.recalled', { ids: recalled.lessons.map((lesson) => lesson.id), holdout: recalled.holdout, tokens: recalled.tokens }, node.id)
    const inputs: Array<{ path: string; version?: number; text: string }> = []
    for (const input of identity.snapshot ? [] : ns.inputs ?? []) inputs.push({ path: input.path, version: input.version, text: (await stores.workspaces.readArtifact(input))?.toString() ?? '' })
    const schema = completionSchema(node.resultSchema, node.completion)
    const completion = completionPrompt(node.completion)
    add('prompt', node.title, [task, completion, retryNote].filter(Boolean).join('\n'))
    const budgetTokens = stores.config.contextBudgetTokens ?? 200000
    // 输入按声明顺序内联，放不下的只给路径让 agent 自己读：全文硬塞会让整个提示超出 harness 的上下文窗口
    let room = budgetTokens - items.reduce((sum, item) => sum + item.tokens, 0)
    const artifacts: string[] = [], deferred: string[] = []
    for (const input of inputs) {
      const tokens = estimateTokens(input.text), included = tokens <= room
      items.push({ id: `artifact-${items.length}`, source: 'artifact', title: input.path, ref: input.path, tokens, included, ...(included ? {} : { reason: '超出上下文预算，只给路径' }) })
      if (included) { room -= tokens; artifacts.push(`${input.path}@${input.version ?? 'latest'}：\n${input.text}`) } else deferred.push(input.path)
    }
    if (deferred.length) artifacts.push(`以下输入超出上下文预算没有内联，需要时从公共存放区读取：${deferred.join(', ')}`)
    const context = { nodeId: node.id, at: host.timestamp(), budgetTokens, totalTokens: items.filter((item) => item.included).reduce((sum, item) => sum + item.tokens, 0), items }
    await stores.runs.saveContext(host.state.runId, context)
    await host.emit('context.assembled', context, node.id)
    const prompt = [skills, ...summaries, lessonText, ...artifacts,
      identity.snapshot ? snapshotPrompt(stores.taktDir, identity.snapshot) : `公共存放区：${ctx.workspaceDir}，需要读的文件：${(ns.inputs ?? []).map((i) => i.path).join(', ')}，需要产出的文件：${(node.outputs ?? []).map((o) => o.path).join(', ')}，写权限：角色 ${JSON.stringify(profile.writeScope)} 与节点 ${JSON.stringify(node.writeScope ?? profile.writeScope)} 的交集；运行脚本、测试生成的文件也算你的写入，写到范围外会判越界。`,
      task, knowledgeTools, completion,
    ].filter(Boolean).join('\n\n')
    const priorOutputs = ns.outputs.length || node.session !== 'resume' ? ns.outputs
      : ((await stores.events.read(host.state.runId, { nodeId: node.id, types: ['node.finished'] })).at(-1)?.data as EventPayloads['node.finished'] | undefined)?.outputs ?? []
    const chain = harnessSelectors(base)
    let previous = ''
    for (const [index, selector] of chain.entries()) {
      host.signal.throwIfAborted()
      if (index) await host.emit('log', { level: 'warn', message: `切换 harness → ${selector.harness}：${previous}` }, node.id)
      const { harness, model, provider, modelConfig, pairing } = resolveHarnessSelector(selector, stores.config, harnesses, host.deps.bridge)
      const available = await harness.available().catch((error: unknown) => ({ ok: false, reason: String(error) }))
      if (!available.ok) { previous = available.reason ?? `${selector.harness} unavailable`; continue }
      const resume = node.session === 'resume' && harness.capabilities?.resume
      const history = node.session === 'resume' && !resume
        ? `该 harness 不支持续聊，本次使用新会话。上一轮产物清单：\n${priorOutputs.length ? priorOutputs.map((ref) => `${ref.workspace}/${ref.path} (version ${ref.version ?? 'latest'})`).join('\n') : '（无已登记产物）'}` : ''
      const format = schema ? harness.capabilities?.structuredOutput ? `最终结果按要求的结构返回（满足：${JSON.stringify(schema)}）` : `最后输出一个 \`\`\`json 代码块，满足：${JSON.stringify(schema)}` : ''
      const requestPrompt = [prompt, format, history, retryNote].filter(Boolean).join('\n\n')
      if (history) {
        const historyItem: ContextItem = { id: `history-${index}`, source: 'history', title: '上一轮产物清单', tokens: estimateTokens(history), included: true }
        const resumedContext = { ...context, at: host.timestamp(), items: [...items, historyItem], totalTokens: context.totalTokens + historyItem.tokens }
        await stores.runs.saveContext(host.state.runId, resumedContext)
        await host.emit('context.assembled', resumedContext, node.id)
      }
      delete ns.usage
      const writeScope = intersectWriteScopes(profile.writeScope, node.writeScope)
      const actor: Actor = { type: 'agent', role: node.role, harness: harness.id, model }
      const request: HarnessRequest = { prompt: requestPrompt, cwd, model, effort: selector.effort, provider,
        modelConfig: modelConfig ? { price: modelConfig.price, contextWindow: modelConfig.contextWindow } : undefined,
        systemAppend: profile.instructions, timeoutMs: node.timeoutMs,
        resultSchema: harness.capabilities?.structuredOutput ? schema : undefined,
        sessionId: resume && ns.sessionRef?.harness === harness.id ? ns.sessionRef.sessionId : undefined,
        readOnly: identity.snapshot ? true : undefined,
        tools: { writeScope: identity.snapshot ? [] : writeScope, allowBash: !identity.snapshot && profile.allowBash === true },
        signal: node.timeoutMs ? AbortSignal.any([host.signal, AbortSignal.timeout(node.timeoutMs)]) : host.signal,
      }
      let repairStarted = false
      const invokeOnce = async (request: HarnessRequest, repair = 0): Promise<HarnessResult> => {
        repairStarted ||= repair > 0
        const requestPrompt = request.prompt
        let callUsage: Usage | undefined
        const transcript = join(runDir(stores.taktDir, host.state.runId), 'transcripts', `${node.id}.jsonl`)
        await assertNoSymlinks(stores.taktDir, transcript)
        await mkdir(dirname(transcript), { recursive: true })
        const env: Record<string, string> = { TAKT_ROLE: node.role, TAKT_NODE: node.id, TAKT_NODE_ID: node.id, TAKT_KB_BASES: JSON.stringify(spec?.bases ?? []), TAKT_WORKSPACE: ctx.workspaceDir, TAKT_RUN_ID: host.state.runId, TAKT_REQ: ctx.requirementId, TAKT_TRANSCRIPT: transcript }
        const apiKey = pairing?.mode !== 'bridge' && provider?.apiKeyEnv ? resolveSecret(provider.apiKeyEnv) : undefined
        if (provider?.apiKeyEnv && apiKey) env[provider.apiKeyEnv] = apiKey
        const sandbox = await sandboxCall(host, cwd, harness.id, ctx, env, node.timeoutMs, directories, identity.snapshot)
        let finishGuard: () => Promise<{ paths: string[]; action: 'flagged'; ambiguous: boolean }>
        try {
          const scope = repair ? { profile: [], node: [] } : { profile: profile.writeScope, node: node.writeScope }
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
        }
        catch (error) { await sandbox.dispose(); throw error }
        let finishOutputs: () => Promise<Array<{ path: string; sha256: string }>>
        try {
          const quarantine = node.strictOutputs ? join(stores.taktDir, 'quarantine', ctx.runId, node.id) : undefined
          if (quarantine) await assertNoSymlinks(stores.taktDir, quarantine)
          finishOutputs = await host.guard.watchOutputs(ctx.workspaceDir, node.outputs?.map((output) => output.path) ?? [], quarantine)
        } catch (error) {
          try { await finishGuard() } finally { await sandbox.dispose() }
          throw error
        }
        let invocation: Awaited<ReturnType<typeof startInvocation>>
        try {
          const recipe = await recordRecipe(host, node, cwd, { ...selector, harness: harness.id, model }, recalled && !recalled.holdout ? recalled.lessons.map(lesson => lesson.id) : [], task)
          invocation = await startInvocation(host, node.id, node.role, harness, selector, { model, effort: selector.effort, provider: provider?.id, pairing }, index, cwd, identity, recipe.recipeKey, repair || undefined)
        } catch (error) {
          try { await finishGuard(); await finishOutputs() } finally { await sandbox.dispose() }
          throw error
        }
        if (actor.type === 'agent') actor.invocationId = invocation.id
        const startedAt = Date.now()
        let reported: InvocationEnd['reported']
        let reportedSessionId: string | undefined
        const toolStarts = new Map<string, number>()
        let eventChain = Promise.resolve()
        let eventError: unknown
        const redactBridge = <T>(value: T): T => redactValue(value, createRedactor(collectSecrets({ ...request, env })))
        const onEvent = (event: HarnessEvent): void => {
          event = redactBridge(event)
          const receivedAt = Date.now()
          eventChain = eventChain.then(async () => {
            if (event.type === 'started') {
              reported = { model: event.model, effort: event.effort, skills: event.skills }
              reportedSessionId = event.sessionId
              if (event.sessionId) ns.sessionRef = { harness: harness.id, sessionId: event.sessionId }
              await host.emit('harness.started', { harness: harness.id, model: event.model, sessionId: event.sessionId, contextWindow: modelConfig?.contextWindow, skills: event.skills }, node.id, actor)
            } else if (event.type === 'usage') {
              if (harness.capabilities?.usage) {
                const usage = priced(event.usage, modelConfig?.price)
                callUsage = addUsage(callUsage ?? { inputTokens: 0, outputTokens: 0 }, usage)
                await host.emit('harness.usage', usage, node.id, actor)
              }
            } else if (event.type === 'compacted') {
              const record = { ...event.record, nodeId: node.id }
              await stores.runs.saveCompaction(host.state.runId, record)
              await host.emit('context.compacted', record, node.id, actor)
            } else if (event.type === 'message') {
              if (event.role === 'system' && event.text.startsWith('原生结构约束已降级')) await host.emit('log', { level: 'warn', message: event.text }, node.id, actor)
              await host.emit('harness.message', { role: event.role, text: event.text }, node.id, actor)
            } else {
              if (event.phase === 'start' && event.callId) toolStarts.set(event.callId, receivedAt)
              const start = event.callId ? toolStarts.get(event.callId) : undefined
              const durationMs = event.durationMs ?? (event.phase === 'end' && start !== undefined ? receivedAt - start : undefined)
              if (event.phase === 'end' && event.callId) toolStarts.delete(event.callId)
              await host.emit('harness.tool_call', { tool: event.tool, input: event.input, output: event.output, ok: event.ok, phase: event.phase, callId: event.callId, durationMs }, node.id, actor)
            }
          }).catch((error: unknown) => { eventError ??= error })
        }
        let result: HarnessResult | undefined
        let failure: unknown
        let route: Awaited<ReturnType<NonNullable<EngineDeps['bridge']>['open']>> | undefined
        try {
          await host.emit('harness.message', { role: 'user', text: redactBridge(requestPrompt) }, node.id, actor)
          request = { ...request, sandbox, env }
          if (pairing?.mode === 'bridge') {
            route = await host.deps.bridge!.open(provider!, pairing.protocol!, { model, signal: request.signal })
            request.provider = route.provider
            Object.assign(env, route.env)
          }
          result = stores.kb ? await host.guard.system(['.takt/knowledge/queries.jsonl'], () => harness.run(request, onEvent)) : await harness.run(request, onEvent)
        } catch (error) { failure = error }
        finally { try { await route?.close() } catch (error) { failure ??= error }; try { await sandbox.dispose() } catch (error) { failure ??= error } }
        if (result) result = redactBridge(result)
        if (failure) {
          if (failure instanceof Error) failure.message = redactBridge(failure.message)
          else failure = redactBridge(String(failure))
        }
        await eventChain
        let invocationFailure: unknown = failure ?? eventError
        try {
          let violation: Awaited<ReturnType<typeof finishGuard>>
          try { violation = await finishGuard() } catch (error) { await finishOutputs(); throw error }
          const untracked = await finishOutputs()
          if (node.strictOutputs && untracked.length) await host.emit('guard.violation', { rule: 'output-contract', paths: untracked.map((item) => item.path), action: 'reverted' }, node.id, actor)
          else for (const item of untracked) await host.emit('artifact.untracked', item, node.id, actor)
          await saveWorktreeDiff(host, node.id, ns, undefined, actor)
          if (violation.paths.length) {
            await host.emit('guard.violation', { rule: violation.ambiguous ? 'concurrent-write' : 'writeScope', paths: violation.paths, action: violation.action }, node.id, violation.ambiguous ? { type: 'system', id: 'engine' } : actor)
            throw new BlockedError(`写权限越界：${violation.paths.join(', ')}`)
          }
          host.signal.throwIfAborted()
          if (eventError) throw eventError
          if (failure || !result?.ok) {
            previous = failure instanceof Error ? failure.message : String(failure ?? result?.error ?? 'harness failed')
            invocationFailure = previous
            throw failure instanceof Error ? failure : new Error(previous)
          }
          if (result.sessionId) ns.sessionRef = { harness: harness.id, sessionId: result.sessionId }
          if (harness.capabilities?.usage && result.usage) {
            const usage = priced(result.usage, modelConfig?.price)
            const delta = { inputTokens: Math.max(0, usage.inputTokens - (callUsage?.inputTokens ?? 0)), outputTokens: Math.max(0, usage.outputTokens - (callUsage?.outputTokens ?? 0)),
              ...(usage.cachedTokens !== undefined ? { cachedTokens: Math.max(0, usage.cachedTokens - (callUsage?.cachedTokens ?? 0)) } : {}),
              ...(usage.costUsd !== undefined ? { costUsd: Math.max(0, usage.costUsd - (callUsage?.costUsd ?? 0)) } : {}) }
            if (!callUsage || delta.inputTokens || delta.outputTokens || delta.cachedTokens || delta.costUsd) await host.emit('harness.usage', delta, node.id, actor)
            callUsage = usage
          }
          if (!harness.capabilities?.usage || !callUsage) {
            const inputTokens = estimateTokens(profile.instructions) + estimateTokens(requestPrompt)
            const outputTokens = estimateTokens(result.finalText)
            const price = modelConfig?.price
            const estimated = { inputTokens, outputTokens, ...(price ? { costUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000 } : {}), note: 'estimated' }
            callUsage = { inputTokens, outputTokens, ...(estimated.costUsd !== undefined ? { costUsd: estimated.costUsd } : {}) }
            await host.emit('harness.usage', estimated, node.id, actor)
          }
          return { ...result, sessionId: result.sessionId ?? reportedSessionId ?? request.sessionId, usage: callUsage }
        } catch (error) { invocationFailure = error; throw error }
        finally {
          callUsage ??= result?.usage ? priced(result.usage, modelConfig?.price) : undefined
          if (callUsage) ns.usage = addUsage(ns.usage ?? { inputTokens: 0, outputTokens: 0 }, callUsage)
          await host.save()
          await host.emit('invocation.finished', { id: invocation.id, outcome: host.signal.aborted ? 'cancelled' : invocationFailure ? 'error' : 'ok',
            error: invocationFailure ? String(invocationFailure instanceof Error ? invocationFailure.message : invocationFailure) : undefined,
            usage: callUsage ?? result?.usage, sessionId: result?.sessionId ?? reportedSessionId ?? request.sessionId, reported, durationMs: Date.now() - startedAt }, node.id, actor)
        }
      }
      try {
        const result = schema ? await runStructured(harness, request, schema, {
          repairs: stores.config.output?.repairs,
          invoke: invokeOnce,
          validate: data => [...completionErrors(node.completion ?? [], data), ...(validateOutput?.(data) ?? [])],
          onInvalid: event => host.emit('output.invalid', event, node.id, actor),
          onRepaired: event => host.emit('output.repaired', event, node.id, actor),
        }) : await invokeOnce(request)
        const data = schema ? result.structured : result.structured ?? result.finalText
        ns.summary = resultSummary(typeof data === 'string' ? extractJsonBlock(result.finalText) ?? data : data, result.finalText)
        if (node.completion?.length) {
          const checked = checkCompletion(node.completion, data)
          ns.checks = checked.checks
          await host.emit('node.checks', checked, node.id, actor)
          if (checked.unmet.length) throw new FailureError(`完成标准未满足：${checked.unmet.join('、')}`, 'completion.unmet', checked.unmet.join(','))
        }
        return { data, actor }
      } catch (error) {
        previous = error instanceof Error ? error.message : String(error)
        if (!repairStarted && !(error instanceof FailureError) && !(error instanceof BlockedError) && /429|503|401|sign in|timeout/i.test(previous) && index < chain.length - 1) continue
        throw error
      }
    }
    throw new Error(previous || '没有可用 harness')
  }
  return acquireSlot ? host.semaphore.use(invoke) : invoke()
}

/** harness 报了 token 没报成本（或接别家 API 时丢掉了不可信的成本）时，按模型别名登记的价格算。 */
function priced(usage: Usage, price: ModelConfig['price']): Usage {
  if (usage.costUsd !== undefined || !price) return usage
  return { ...usage, costUsd: (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000 }
}
