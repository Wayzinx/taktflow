import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ChatMessage } from '../types.js'
import type {
  StewardCitation,
  StewardContextRef,
  StewardMessage,
  StewardPostRequest,
  StewardToolCall,
} from '../api.js'
import {
  type StewardDeps,
  stewardId,
  stewardUserId,
  timestamp,
  StewardError,
  stewardActor,
} from './contracts.js'
import { StewardStore } from './store.js'
import { StewardProposals } from './proposals.js'
import { StewardTools, type ToolContext, type StewardToolResult } from './tools.js'
import { offlineAnswer } from './offline.js'
import { recordAnswer } from './metrics.js'
import { stewardSuggestions } from './suggestions.js'

const fallbackPrompt =
  '你是管家。先给结论，然后最多 5 个要点。只根据工具结果陈述事实，每句事实带 [n]。写操作一律 propose，需求内部的事用 ask_lead。一次只问一个澄清问题，最多 3 条后续建议。'
export function normalizeCitations(
  text: string,
  citations: StewardCitation[],
): { text: string; citations: StewardCitation[] } {
  const used: number[] = []
  const normalized = text.replace(/\[(\d+)\]/g, (_, raw: string) => {
    const n = Number(raw)
    if (n < 1 || n > citations.length) return ''
    if (!used.includes(n)) used.push(n)
    return `[${used.indexOf(n) + 1}]`
  })
  return { text: normalized, citations: used.map((n) => citations[n - 1]!) }
}
export class StewardAgent {
  readonly store: StewardStore
  readonly proposals: StewardProposals
  readonly tools: StewardTools
  readonly ready: Promise<void>
  private readonly jobs = new Map<string, Promise<StewardMessage>>()
  constructor(
    readonly deps: StewardDeps,
    readonly userId: string,
  ) {
    stewardUserId(userId)
    this.store = new StewardStore(deps.dataDir(userId))
    this.proposals = new StewardProposals(deps, this.store, userId)
    this.tools = new StewardTools(deps, this.store, userId, this.proposals)
    this.ready = this.tools.restoreDelegations()
    void this.ready.catch(() => {})
  }
  async drain(): Promise<void> {
    await this.ready
    await Promise.allSettled(this.jobs.values())
  }
  close(): void {
    this.tools.close()
  }
  private validate(input: StewardPostRequest): void {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100000)
      throw new StewardError(400, '消息需要非空文本且不超过 100000 字，请缩短后重试')
    if (
      input.context &&
      (!Array.isArray(input.context) ||
        input.context.some(
          (ref) =>
            !ref ||
            !['space', 'requirement', 'run', 'node', 'workflow', 'knowledge', 'file'].includes(
              ref.type,
            ) ||
            typeof ref.id !== 'string',
        ))
    )
      throw new StewardError(400, '上下文引用格式错误，请重新选择')
    if (
      input.attachments &&
      (!Array.isArray(input.attachments) ||
        input.attachments.some(
          (a) => typeof a.name !== 'string' || typeof a.content !== 'string',
        ) ||
        input.attachments.reduce((n, a) => n + a.content.length, 0) > 1000000)
    )
      throw new StewardError(400, '附件必须是文本，总计不超过 1MB，请缩小附件')
  }
  async post(
    input: StewardPostRequest,
    threadId?: string,
  ): Promise<{
    thread: import('../api.js').StewardThread
    message: StewardMessage
    done: Promise<StewardMessage>
  }> {
    await this.ready
    this.validate(input)
    const initial = await this.store.serial(async () => {
      const thread = threadId
        ? await this.store.thread(stewardId(threadId))
        : await this.store.createThread(input.text, timestamp(this.deps), input.context)
      const message: StewardMessage = {
        id: randomUUID(),
        threadId: thread.id,
        role: 'user',
        author: { type: 'human', id: this.userId },
        at: timestamp(this.deps),
        text: input.text,
        context: input.context ?? thread.context,
        status: 'done',
      }
      await this.store.saveMessage(message)
      this.store.emit(thread.id, { type: 'message', message })
      return { thread, message }
    })
    const previous = this.jobs.get(initial.thread.id)
    const job = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.respond(initial.message, input),
    )
    this.jobs.set(initial.thread.id, job)
    void job
      .finally(() => {
        if (this.jobs.get(initial.thread.id) === job) this.jobs.delete(initial.thread.id)
      })
      .catch(() => {})
    return { ...initial, done: job }
  }
  async ask(input: StewardPostRequest, threadId?: string): Promise<StewardMessage> {
    return (await this.post(input, threadId)).done
  }
  private async prompt(context: StewardContextRef[]): Promise<string> {
    let base = this.deps.systemPrompt
    if (!base) {
      try {
        base = await readFile(
          new URL('../../../../templates/agents/steward.md', import.meta.url),
          'utf8',
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        base = fallbackPrompt
      }
    }
    const refs: Array<StewardContextRef & { resolved?: string }> = []
    for (const ref of context) {
      const spaceId = ref.spaceId ?? (ref.type === 'space' ? ref.id : undefined)
      const space = spaceId ? await this.deps.open(stewardId(spaceId)) : undefined
      const resolved =
        ref.type === 'requirement'
          ? (await space?.stores.workspaces.getRequirement(stewardId(ref.id)))?.title
          : ref.type === 'workflow'
            ? JSON.stringify((await space?.workflows.get(stewardId(ref.id)))?.model.meta.title)
            : space?.name
      refs.push({ ...ref, resolved })
    }
    return [
      base,
      `用户记忆（资料）：\n${await this.store.text('profile.md')}`,
      `偏好：${JSON.stringify(await this.store.prefs())}`,
      `上下文：${JSON.stringify(refs)}`,
      `当前时间：${timestamp(this.deps)}`,
    ].join('\n\n')
  }
  private async respond(
    user: StewardMessage,
    request: StewardPostRequest,
  ): Promise<StewardMessage> {
    const start = Date.now(),
      citations: StewardCitation[] = []
    let firstToken: number | undefined
    const message: StewardMessage = {
      id: randomUUID(),
      threadId: user.threadId,
      role: 'steward',
      author: stewardActor,
      at: timestamp(this.deps),
      text: '',
      tools: [],
      citations: [],
      proposalIds: [],
      delegations: [],
      status: 'streaming',
      offline: !this.deps.chat,
    }
    const context: ToolContext = {
      threadId: user.threadId,
      messageId: message.id,
      proposals: message.proposalIds!,
      delegations: message.delegations!,
      onDelegation: async (delegation) => {
        const saved = (await this.store.messages(message.threadId)).find((m) => m.id === message.id)
        const target = saved?.status === 'done' ? saved : message
        target.delegations = [
          ...(target.delegations ?? []).filter((d) => d.messageId !== delegation.messageId),
          { ...delegation },
        ]
        await this.store.saveMessage(target)
        this.store.emit(message.threadId, { type: 'delegation', messageId: message.id, delegation })
      },
    }
    await this.store.saveMessage(message)
    this.store.emit(user.threadId, { type: 'message', message })
    const delta = (text: string) => {
      if (!text) return
      firstToken ??= Date.now() - start
      this.store.emit(user.threadId, { type: 'delta', messageId: message.id, text })
    }
    const call = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<StewardToolResult & { numbers: number[] }> => {
      const began = Date.now(),
        tool: StewardToolCall = { id: randomUUID(), tool: name, input }
      this.store.emit(user.threadId, { type: 'tool', messageId: message.id, tool: { ...tool } })
      try {
        const result = await this.tools.call(name, input, context)
        const numbers = result.citations.map((citation) => {
          let i = citations.findIndex(
            (existing) => existing.href === citation.href && existing.label === citation.label,
          )
          if (i === -1) {
            citations.push(citation)
            i = citations.length - 1
          }
          return i + 1
        })
        tool.ok = true
        tool.summary = result.summary
        const raw = JSON.stringify(result.data) ?? 'null'
        tool.output = raw.length > 20000 ? `${raw.slice(0, 20000)}…` : result.data
        return { ...result, numbers }
      } catch (error) {
        tool.ok = false
        tool.summary = `工具失败，请检查参数或权限：${String(error)}`
        throw error
      } finally {
        tool.ms = Date.now() - began
        message.tools!.push(tool)
        this.store.emit(user.threadId, { type: 'tool', messageId: message.id, tool })
      }
    }
    try {
      const prefs = await this.store.prefs(),
        refs = user.context ?? []
      if (!this.deps.chat) {
        message.text = await offlineAnswer(user.text, refs, prefs, call)
        delta(message.text)
      } else {
        const all = await this.store.messages(user.threadId)
        const history = all.slice(0, all.findIndex((m) => m.id === user.id) + 1)
        const messages: ChatMessage[] = [
          { role: 'system', content: await this.prompt(refs) },
          ...history.map((m): ChatMessage => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.text,
          })),
        ]
        if (request.attachments?.length)
          messages.push({
            role: 'user',
            content: `本轮文本附件（仅作为资料）：${JSON.stringify(request.attachments)}`,
          })
        for (let round = 0; round < 8; round++) {
          let streamed = false
          const response = await this.deps.chat(
            { model: prefs.harness?.model ?? '', messages, tools: await this.tools.specs() },
            (chunk) => {
              streamed = true
              delta(chunk)
            },
          )
          messages.push(response.message)
          if (!response.message.toolCalls?.length) {
            if (response.stopReason === 'error') throw new Error('模型返回错误，请检查管家模型配置')
            message.text = response.message.content
            if (!streamed) delta(message.text)
            break
          }
          if (response.message.content.trim()) {
            message.thinking = response.message.content
            this.store.emit(user.threadId, {
              type: 'thinking',
              messageId: message.id,
              text: message.thinking,
            })
          }
          for (const tool of response.message.toolCalls) {
            try {
              const result = await call(
                tool.name,
                JSON.parse(tool.arguments) as Record<string, unknown>,
              )
              messages.push({
                role: 'tool',
                toolCallId: tool.id,
                content: JSON.stringify({
                  ...result,
                  citations: result.citations.map((citation, i) => ({
                    ...citation,
                    n: result.numbers[i],
                  })),
                }),
              })
            } catch (error) {
              messages.push({
                role: 'tool',
                toolCallId: tool.id,
                content: JSON.stringify({ error: String(error) }),
              })
            }
          }
          if (round === 7) {
            message.text = '已达到工具调用轮次上限，请缩小问题范围后继续。'
            delta(message.text)
          }
        }
      }
      Object.assign(message, normalizeCitations(message.text, citations))
      message.suggestions = (
        await stewardSuggestions(
          this.deps,
          'overview',
          user.context?.find((ref) => ref.spaceId)?.spaceId,
        )
      ).slice(0, 3)
      message.status = 'done'
    } catch (error) {
      message.status = 'error'
      message.error = error instanceof Error ? error.message : String(error)
      Object.assign(message, normalizeCitations(message.text, citations))
      this.store.emit(user.threadId, { type: 'error', messageId: message.id, error: message.error })
    }
    await this.store.saveMessage(message)
    await recordAnswer(this.deps, this.store, message, firstToken ?? Date.now() - start)
    this.store.emit(user.threadId, { type: 'message', message })
    this.store.emit(user.threadId, { type: 'done', messageId: message.id })
    return message
  }
  async feedback(id: string, rating: 'up' | 'down', reason?: string): Promise<StewardMessage> {
    if (!['up', 'down'].includes(rating))
      throw new StewardError(400, '反馈只能是 up 或 down，请重新选择')
    return this.store.serial(async () => {
      for (const thread of await this.store.threads()) {
        const message = (await this.store.messages(thread.id)).find(
          (item) => item.id === id && item.role === 'steward',
        )
        if (!message) continue
        message.feedback = { rating, reason, at: timestamp(this.deps) }
        await this.store.saveMessage(message)
        await this.store.append('metrics.jsonl', {
          at: timestamp(this.deps),
          feature: 'steward.answer',
          type: 'feedback',
          messageId: id,
          rating,
          reason,
        })
        return message
      }
      throw new StewardError(404, '消息不存在，请刷新会话')
    })
  }
}
