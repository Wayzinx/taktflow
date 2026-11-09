import { createHash } from 'node:crypto'
import { contentText, decodeThinking, type BridgeRequest, type Wire } from './wire.js'

/** 命名空间里的工具展平成 `ns__name`；函数名上限 64 字符，超长时截断加短哈希。 */
function flatName(namespace: string, name: string): string {
  const full = `${namespace}__${name}`.replace(/[^A-Za-z0-9_-]/g, '_')
  return full.length <= 64 ? full : `${full.slice(0, 55)}_${createHash('sha256').update(full).digest('hex').slice(0, 8)}`
}

function content(parts: any): any {
  if (typeof parts === 'string') return parts
  return (parts ?? []).flatMap((p: Wire) => {
    if (['text', 'input_text', 'output_text'].includes(p.type)) return [{ type: 'text', text: p.text }]
    if (p.type === 'input_image') return [{ type: 'image_url', image_url: { url: p.image_url, ...(p.detail ? { detail: p.detail } : {}) } }]
    if (p.type === 'image') return [{ type: 'image_url', image_url: { url: p.source.type === 'base64' ? `data:${p.source.media_type};base64,${p.source.data}` : p.source.url } }]
    return []
  })
}

export function mapRequest(body: Wire, anthropic: boolean): BridgeRequest {
  const messages: Wire[] = [], tools: Wire[] = [], custom = new Set<string>(), system: string[] = []
  const namespaces = new Map<string, { namespace: string; name: string }>(), names = new Set<string>()
  const options: Wire = {}
  if (anthropic ? body.system : body.instructions) system.push(contentText(anthropic ? body.system : body.instructions))
  const addTools = (items: Wire[], namespace?: string) => {
    for (const t of items) {
      if (t.type === 'namespace') { addTools(t.tools ?? [], t.name); continue }
      if ((!anthropic && t.type === 'function') || (anthropic && !t.type)) {
        const name = namespace ? flatName(namespace, t.name) : t.name
        if (names.has(name)) { console.warn('协议桥已忽略重名工具'); continue }
        names.add(name)
        if (namespace) namespaces.set(name, { namespace, name: t.name })
        tools.push({ type: 'function', function: { name, description: t.description, parameters: anthropic ? t.input_schema : t.parameters } })
      }
      else if (t.type === 'custom') {
        custom.add(t.name)
        tools.push({ type: 'function', function: { name: t.name, description: `${t.description ?? ''}\n${JSON.stringify(t.format ?? {})}`, parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } } })
      } else console.warn('协议桥已忽略上游不支持的托管工具')
    }
  }
  addTools(body.tools ?? [])
  const input = anthropic ? body.messages : typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
  let pendingThinking: { text: string; signature: string } | undefined
  for (const item of input ?? []) {
    if (['system', 'developer'].includes(item.role)) { system.push(contentText(item.content)); continue }
    if (!anthropic && item.type === 'reasoning') { pendingThinking = decodeThinking(item.encrypted_content); continue }
    if (!anthropic && ['function_call', 'custom_tool_call'].includes(item.type)) {
      let last = messages.at(-1)
      if (last?.role !== 'assistant') { last = { role: 'assistant', content: '' }; messages.push(last) }
      last.tool_calls ??= []
      if (pendingThinking) { last.reasoning_content = pendingThinking.text; last.thinking_signature = pendingThinking.signature; pendingThinking = undefined }
      const name = item.namespace ? flatName(item.namespace, item.name) : item.name
      last.tool_calls.push({ id: item.call_id, type: 'function', function: { name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments } })
      continue
    }
    if (!anthropic && ['function_call_output', 'custom_tool_call_output'].includes(item.type)) { messages.push({ role: 'tool', tool_call_id: item.call_id, content: content(item.output) }); continue }
    if (!item.role) continue
    const parts: Wire[] = Array.isArray(item.content) ? item.content : []
    const msg: Wire = { role: item.role, content: content(item.content) }
    const calls = parts.filter(p => p.type === 'tool_use')
    if (calls.length) msg.tool_calls = calls.map(p => ({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) } }))
    const thinking = parts.filter(p => p.type === 'thinking').map(p => decodeThinking(p.signature)).filter(p => p !== undefined)
    if (pendingThinking) { thinking.push(pendingThinking); pendingThinking = undefined }
    if (thinking.length) { msg.reasoning_content = thinking.map(p => p.text).join(''); msg.thinking_signature = thinking.at(-1)!.signature }
    // 工具结果先于同一 user 消息的后续文本；不能把空工具回执当成新用户回合。
    for (const p of parts.filter(p => p.type === 'tool_result')) messages.push({ role: 'tool', tool_call_id: p.tool_use_id, content: content(p.content), ...(p.is_error ? { is_error: true } : {}) })
    if (typeof msg.content === 'string' ? !!msg.content : msg.content.length || msg.tool_calls || msg.reasoning_content) messages.push(msg)
  }
  let lastUser = -1
  messages.forEach((m, i) => { if (m.role === 'user') lastUser = i })
  for (const [i, m] of messages.entries()) if (i < lastUser) { delete m.reasoning_content; delete m.thinking_signature }
  const format = body.text?.format
  if (format?.type === 'json_schema') system.push(`最终回复必须是满足以下 JSON Schema 的 JSON\n${JSON.stringify(format.schema)}`)
  if (system.length) messages.unshift({ role: 'system', content: system.join('\n\n') })
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls']) if (body[key] !== undefined) options[key] = body[key]
  if (body.max_tokens ?? body.max_output_tokens) options.max_tokens = body.max_tokens ?? body.max_output_tokens
  if (body.stop_sequences) options.stop = body.stop_sequences
  if (body.tool_choice !== undefined) {
    const t = body.tool_choice
    options.tool_choice = anthropic ? ({ auto: 'auto', any: 'required', none: 'none' }[t.type as string] ?? { type: 'function', function: { name: t.name } })
      : typeof t === 'object' && ['function', 'custom'].includes(t.type) ? { type: 'function', function: { name: t.name } } : t
  }
  return { messages, tools, custom, namespaces, options }
}

export function upstreamBody(req: BridgeRequest, model: string, anthropic: boolean): Wire {
  if (!anthropic) return { ...req.options, model, messages: req.messages.map(({ thinking_signature, is_error, ...m }) => is_error ? { ...m, content: typeof m.content === 'string' ? `工具执行失败：${m.content}` : [{ type: 'text', text: '工具执行失败：' }, ...m.content] } : m), ...(req.tools.length ? { tools: req.tools } : {}), stream: true, stream_options: { include_usage: true } }
  const messages: Wire[] = []
  for (const m of req.messages.filter(m => m.role !== 'system')) {
    const parts: Wire[] = typeof m.content === 'string' ? (m.content ? [{ type: 'text', text: m.content }] : []) : m.content.map((p: Wire) => {
      if (p.type !== 'image_url') return p
      const data = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url)
      return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: p.image_url.url } }
    })
    if (m.reasoning_content && m.thinking_signature) parts.unshift({ type: 'thinking', thinking: m.reasoning_content, signature: m.thinking_signature })
    for (const call of m.tool_calls ?? []) parts.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') })
    const entry = m.role === 'tool' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: parts, ...(m.is_error ? { is_error: true } : {}) }] } : { role: m.role, content: parts }
    if (messages.at(-1)?.role === entry.role) messages.at(-1)!.content.push(...entry.content)
    else messages.push(entry)
  }
  const { stop, tool_choice, parallel_tool_calls, ...opts } = req.options
  const choice = tool_choice ? typeof tool_choice === 'string' ? { type: tool_choice === 'required' ? 'any' : tool_choice } : { type: 'tool', name: tool_choice.function.name } : undefined
  const parallel = parallel_tool_calls === undefined ? {} : { disable_parallel_tool_use: !parallel_tool_calls }
  return { ...opts, model, max_tokens: opts.max_tokens ?? 4096, stream: true, messages,
    system: req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
    ...(stop ? { stop_sequences: stop } : {}),
    ...(req.tools.length ? { tools: req.tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}),
    ...(choice || parallel_tool_calls !== undefined ? { tool_choice: { ...(choice ?? { type: 'auto' }), ...parallel } } : {}),
  }
}
