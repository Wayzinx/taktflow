import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EngineDeps } from '../interfaces.js'
import type { Actor, AgentNodeDef, ContextItem, EventPayloads, EventType, HarnessEvent, HarnessResult, HarnessSelector, NodeContext, NodeState, RunState } from '../types.js'
import { estimateTokens } from '../util/tokens.js'
import { assertNoSymlinks } from '../store/fs-utils.js'
import { runDir } from '../store/paths.js'
import { parseResult } from './schema.js'
import { Semaphore } from './process.js'
import { WriteGuard } from './guard.js'

export class BlockedError extends Error {}
export type Emit = <T extends EventType>(type: T, data: EventPayloads[T], nodeId?: string, actor?: Actor) => Promise<void>
export interface HarnessHost {
  deps: EngineDeps
  state: RunState
  emit: Emit
  signal: AbortSignal
  timestamp(): string
  semaphore: Semaphore
  guard: WriteGuard
  override?: string
}

function selectors(selector: HarnessSelector): HarnessSelector[] {
  return [selector, ...(selector.fallback ?? []).flatMap(selectors)]
}

export async function callHarness(host: HarnessHost, node: AgentNodeDef, ctx: NodeContext, ns: NodeState): Promise<{ data: unknown; actor: Actor }> {
  return host.semaphore.use(async () => {
    host.signal.throwIfAborted()
    const { stores, profiles, harnesses, knowledge } = host.deps
    const profile = profiles[node.role]
    if (!profile) throw new Error(`角色不存在：${node.role}`)
    const task = (typeof node.prompt === 'function' ? await node.prompt(ctx) : node.prompt) + (ns.error ? `\n上一次失败原因：${ns.error}` : '')
    const items: ContextItem[] = []
    const add = (source: ContextItem['source'], title: string, text: string, ref?: string) => {
      items.push({ id: `${source}-${items.length}`, source, title, ref, tokens: estimateTokens(text), included: true })
    }
    add('role', profile.title, profile.instructions)
    add('prompt', node.title, task)
    for (const input of ns.inputs ?? []) {
      const text = await ctx.readArtifact(input.path)
      add('artifact', input.path, text ?? '', input.path)
    }
    const summaries: string[] = []
    for (const query of node.knowledge ?? []) {
      const sources = knowledge.filter((source) => query.intent === undefined || source.intents.includes(query.intent))
      const hits = (await Promise.all(sources.map((source) => source.query(query)))).flat()
      await host.emit('knowledge.query', { query, sources: sources.map((s) => s.id), hits: hits.length }, node.id)
      for (const hit of hits) { add('knowledge', hit.title, hit.snippet, hit.ref); summaries.push(`${hit.ref}: ${hit.snippet}`) }
    }
    const context = { nodeId: node.id, at: host.timestamp(), budgetTokens: stores.config.contextBudgetTokens ?? 200000, totalTokens: items.reduce((sum, item) => sum + item.tokens, 0), items }
    await stores.runs.saveContext(host.state.runId, context)
    await host.emit('context.assembled', context, node.id)
    const prompt = [profile.instructions, task, ...summaries,
      `公共存放区：${ctx.workspaceDir}，需要读的文件：${(node.inputs ?? []).map((i) => i.path).join(', ')}，需要产出的文件：${(node.outputs ?? []).map((o) => o.path).join(', ')}，写权限：角色 ${JSON.stringify(profile.writeScope)} 与节点 ${JSON.stringify(node.writeScope ?? profile.writeScope)} 的交集。`,
      node.resultSchema ? `最后输出一个 \`\`\`json 代码块，满足：${JSON.stringify(node.resultSchema)}` : '',
    ].join('\n\n')
    const base = node.harness ?? profile.harness ?? stores.config.roles?.[node.role] ?? { harness: 'mock' }
    const chain = host.override ? [{ ...base, harness: host.override, fallback: undefined }] : selectors(base)
    let previous = ''
    for (const [index, selector] of chain.entries()) {
      host.signal.throwIfAborted()
      if (index) await host.emit('log', { level: 'warn', message: `切换 harness → ${selector.harness}：${previous}` }, node.id)
      const harness = harnesses[selector.harness]
      if (!harness) { previous = `harness 不存在：${selector.harness}`; continue }
      const available = await harness.available().catch((error: unknown) => ({ ok: false, reason: String(error) }))
      if (!available.ok) { previous = available.reason ?? `${selector.harness} unavailable`; continue }
      const model = selector.model ? stores.config.models?.[selector.model] : undefined
      const providerId = selector.provider ?? model?.provider
      const providerConfig = providerId ? stores.config.providers?.[providerId] : undefined
      if (providerId && !providerConfig) throw new Error(`provider 不存在：${providerId}`)
      if (providerId && !harness.capabilities?.customProvider) throw new Error(`harness ${harness.id} 不支持 customProvider`)
      const actor: Actor = { type: 'agent', role: node.role, harness: harness.id, model: model?.id ?? selector.model }
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
            ns.usage = event.usage
            await host.emit('harness.usage', event.usage, node.id, actor)
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
        result = await harness.run({ prompt, cwd: stores.projectDir, model: model?.id ?? selector.model,
          effort: selector.effort, provider: providerId && providerConfig ? { id: providerId, ...providerConfig } : undefined,
          systemAppend: profile.instructions, timeoutMs: node.timeoutMs, resultSchema: node.resultSchema,
          sessionId: node.session === 'resume' && ns.sessionRef?.harness === harness.id ? ns.sessionRef.sessionId : undefined,
          env: { TAKT_ROLE: node.role, TAKT_NODE: node.id, TAKT_WORKSPACE: ctx.workspaceDir, TAKT_RUN_ID: host.state.runId, TAKT_REQ: ctx.requirementId, TAKT_TRANSCRIPT: transcript },
          tools: { writeScope: node.writeScope ?? profile.writeScope },
          signal: node.timeoutMs ? AbortSignal.any([host.signal, AbortSignal.timeout(node.timeoutMs)]) : host.signal,
        }, onEvent)
      } catch (error) { failure = error }
      await eventChain
      const violation = await finishGuard()
      if (violation.paths.length) {
        await host.emit('guard.violation', { rule: 'writeScope', ...violation }, node.id, actor)
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
      if (result.usage) ns.usage = result.usage
      return { data: node.resultSchema ? parseResult(result.finalText, node.resultSchema) : result.structured ?? result.finalText, actor }
    }
    throw new Error(previous || '没有可用 harness')
  })
}
