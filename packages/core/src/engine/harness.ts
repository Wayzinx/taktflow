import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EngineDeps } from '../interfaces.js'
import type { Actor, AgentProfile, AgentNodeDef, ContextItem, EventPayloads, EventType, HarnessEvent, HarnessRequest, HarnessResult, NodeContext, NodeState, RunState } from '../types.js'
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
}

export async function callHarness(host: HarnessHost, node: AgentNodeDef, ctx: NodeContext, ns: NodeState, acquireSlot = true): Promise<{ data: unknown; actor: Actor }> {
  const invoke = async (): Promise<{ data: unknown; actor: Actor }> => {
    host.signal.throwIfAborted()
    const { stores, profiles, harnesses, knowledge } = host.deps
    const profile = profiles[node.role]
    if (!profile) throw new Error(`角色不存在：${node.role}`)
    const selection = { config: stores.config, profiles, harnesses }
    const base = selectHarness(node.role, node.harness, selection, host.override)
    const task = typeof node.prompt === 'function' ? await node.prompt(ctx) : node.prompt
    const retryNote = ns.error ? `上一次失败原因：${ns.error}` : ''
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
    for (const query of node.knowledge ?? []) {
      const { hits, sources } = await createKnowledgeRouter(knowledge).query(query)
      await host.emit('knowledge.query', { query, sources, hits: hits.length }, node.id)
      for (const hit of hits) { add('knowledge', hit.title, hit.snippet, hit.ref); summaries.push(`${hit.ref}: ${hit.snippet}`) }
    }
    const context = { nodeId: node.id, at: host.timestamp(), budgetTokens: stores.config.contextBudgetTokens ?? 200000, totalTokens: items.reduce((sum, item) => sum + item.tokens, 0), items }
    await stores.runs.saveContext(host.state.runId, context)
    await host.emit('context.assembled', context, node.id)
    const prompt = [task, ...summaries,
      `公共存放区：${ctx.workspaceDir}，需要读的文件：${(ns.inputs ?? []).map((i) => i.path).join(', ')}，需要产出的文件：${(node.outputs ?? []).map((o) => o.path).join(', ')}，写权限：角色 ${JSON.stringify(profile.writeScope)} 与节点 ${JSON.stringify(node.writeScope ?? profile.writeScope)} 的交集。`,
      node.resultSchema ? `最后输出一个 \`\`\`json 代码块，满足：${JSON.stringify(node.resultSchema)}` : '',
      retryNote,
    ].filter(Boolean).join('\n\n')
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
      const requestPrompt = [prompt, history].filter(Boolean).join('\n\n')
      if (history) {
        const historyItem: ContextItem = { id: `history-${index}`, source: 'history', title: '上一轮产物清单', tokens: estimateTokens(history), included: true }
        const resumedContext = { ...context, at: host.timestamp(), items: [...items, historyItem], totalTokens: context.totalTokens + historyItem.tokens }
        await stores.runs.saveContext(host.state.runId, resumedContext)
        await host.emit('context.assembled', resumedContext, node.id)
      }
      const writeScope = intersectWriteScopes(profile.writeScope, node.writeScope)
      delete ns.usage
      const actor: Actor = { type: 'agent', role: node.role, harness: harness.id, model }
      const transcript = join(runDir(stores.taktDir, host.state.runId), 'transcripts', `${node.id}.jsonl`)
      await assertNoSymlinks(stores.taktDir, transcript)
      await mkdir(dirname(transcript), { recursive: true })
      const finishGuard = await host.guard.begin({ profile: profile.writeScope, node: node.writeScope })
      let eventChain = Promise.resolve()
      let eventError: unknown
      const onEvent = (event: HarnessEvent): void => {
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
      try {
        await host.emit('harness.message', { role: 'user', text: requestPrompt }, node.id, actor)
        const request: HarnessRequest = { prompt: requestPrompt, cwd: stores.projectDir, model,
          effort: selector.effort, provider,
          modelConfig: modelConfig ? { price: modelConfig.price, contextWindow: modelConfig.contextWindow } : undefined,
          systemAppend: profile.instructions, timeoutMs: node.timeoutMs, resultSchema: harness.capabilities?.structuredOutput ? node.resultSchema : undefined,
          sessionId: resume && ns.sessionRef?.harness === harness.id ? ns.sessionRef.sessionId : undefined,
          env: { TAKT_ROLE: node.role, TAKT_NODE: node.id, TAKT_WORKSPACE: ctx.workspaceDir, TAKT_RUN_ID: host.state.runId, TAKT_REQ: ctx.requirementId, TAKT_TRANSCRIPT: transcript },
          tools: { writeScope, allowBash: profile.allowBash === true },
          signal: node.timeoutMs ? AbortSignal.any([host.signal, AbortSignal.timeout(node.timeoutMs)]) : host.signal,
        }
        result = await harness.run(request, onEvent)
      } catch (error) { failure = error }
      await eventChain
      const violation = await finishGuard()
      if (violation.paths.length) {
        await host.emit('guard.violation', { rule: violation.ambiguous ? 'concurrent-write' : 'writeScope', paths: violation.paths, action: violation.action }, node.id, violation.ambiguous ? system : actor)
        throw new BlockedError(`写权限越界：${violation.paths.join(', ')}`)
      }
      host.signal.throwIfAborted()
      if (eventError) throw eventError
      if (failure || !result?.ok) {
        previous = failure instanceof Error ? failure.message : String(failure ?? result?.error ?? 'harness failed')
        if (/429|503|401|sign in|timeout/i.test(previous) && index < chain.length - 1) continue
        throw new Error(previous)
      }
      if (result.sessionId) ns.sessionRef = { harness: harness.id, sessionId: result.sessionId }
      if (harness.capabilities?.usage && result.usage) ns.usage = result.usage
      if (!harness.capabilities?.usage || !ns.usage) {
        const inputTokens = estimateTokens(profile.instructions) + estimateTokens(requestPrompt)
        const outputTokens = estimateTokens(result.finalText)
        const price = modelConfig?.price
        const estimated = { inputTokens, outputTokens, ...(price ? { costUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000 } : {}), note: 'estimated' }
        ns.usage = { inputTokens, outputTokens, ...(estimated.costUsd !== undefined ? { costUsd: estimated.costUsd } : {}) }
        await host.emit('harness.usage', estimated, node.id, actor)
      }
      await host.save()
      const data = result.structured !== undefined ? result.structured : node.resultSchema ? parseResult(result.finalText, node.resultSchema) : result.finalText
      if (node.resultSchema) validateSchema(data, node.resultSchema)
      return { data, actor }
    }
    throw new Error(previous || '没有可用 harness')
  }
  return acquireSlot ? host.semaphore.use(invoke) : invoke()
}
