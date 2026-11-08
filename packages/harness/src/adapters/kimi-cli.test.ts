import { describe, expect, it } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createKimiCliParser } from './kimi-cli.js'

// 以下两类均为合成格式样例，不是 Kimi CLI 录制或版本兼容性证明。
describe('Kimi 合成 OpenAI message / Wire', () => {
  it('完整 message 模式：工具往返后最后 assistant 为结果', () => {
    const events: HarnessEvent[] = []
    const parser = createKimiCliParser(e => events.push(e))
    const send = (value: unknown) => parser.onLine(JSON.stringify(value))
    send({ role: 'assistant', session_id: 'k1', model: 'kimi-test', content: '读取', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] })
    expect(parser.result().ok).toBe(false)
    send({ role: 'tool', tool_call_id: 't1', content: 'body' })
    expect(parser.result().ok).toBe(false)
    send({ role: 'assistant', content: [{ type: 'text', text: '完成' }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } })
    expect(parser.result()).toEqual({ ok: true, finalText: '完成', sessionId: 'k1', usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 2 } })
    expect(events).toContainEqual({ type: 'started', sessionId: 'k1', model: 'kimi-test' })
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '完成' })
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'read', input: '{"path":"a"}', output: 'body', ok: true })
    expect(events).toContainEqual({ type: 'usage', usage: parser.result().usage })
  })

  it('Wire 的 text、工具和逐 step token_usage；必须有 TurnEnd', () => {
    const events: HarnessEvent[] = []
    const parser = createKimiCliParser(e => events.push(e))
    const send = (type: string, payload: unknown) => parser.onLine(JSON.stringify({ type, payload }))
    send('TurnBegin', { session_id: 'kw', model: 'kimi-test', user_input: 'task' })
    send('StepBegin', { n: 1 })
    send('ToolCall', { id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } })
    send('ToolResult', { tool_call_id: 't1', return_value: { is_error: false, output: 'body' } })
    send('StatusUpdate', { token_usage: { input_other: 10, input_cache_read: 2, input_cache_creation: 1, output: 3 } })
    send('StepBegin', { n: 2 })
    send('ContentPart', { type: 'text', text: '完' })
    send('ContentPart', { type: 'think', think: '不混入回答' })
    send('ContentPart', { type: 'text', text: '成' })
    send('StatusUpdate', { token_usage: { input_other: 20, input_cache_read: 4, input_cache_creation: 2, output: 6 } })
    expect(parser.result()).toMatchObject({ ok: false, finalText: '完成' })
    send('TurnEnd', {})
    expect(parser.result()).toEqual({ ok: true, finalText: '完成', sessionId: 'kw', usage: { inputTokens: 39, outputTokens: 9, cachedTokens: 6 } })
    expect(events.filter(e => e.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 13, outputTokens: 3, cachedTokens: 2 } },
      { type: 'usage', usage: { inputTokens: 26, outputTokens: 6, cachedTokens: 4 } },
    ])
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'read', input: '{"path":"a"}', output: 'body', ok: true })
  })

  it('两轮工具往返后只保留最新 step 的 chunks，较小的下一步用量也完整累加', () => {
    const events: HarnessEvent[] = []
    const parser = createKimiCliParser(e => events.push(e))
    const send = (type: string, payload: unknown) => parser.onLine(JSON.stringify({ type, payload }))
    send('TurnBegin', { session_id: 'multi' })
    for (const [n, input, output] of [[1, 20, 6], [2, 5, 2]]) {
      send('StepBegin', { n })
      send('ContentPart', { type: 'text', text: `第${n}轮准备` })
      send('ContentPart', { type: 'text', text: '调用工具' })
      send('ToolCall', { id: `t${n}`, function: { name: 'read', arguments: '{"path":"a"}' } })
      send('ToolResult', { tool_call_id: `t${n}`, return_value: { is_error: false, output: 'body' } })
      const status = { token_usage: { input_other: input, input_cache_read: 2, input_cache_creation: 1, output } }
      send('StatusUpdate', status)
      send('StatusUpdate', status)
      expect(parser.result().ok).toBe(false)
    }
    expect(parser.result().finalText).toBe('第2轮准备调用工具')
    send('StepBegin', { n: 3 })
    // 首个 text 前保留已有文本，think 不应消耗替换标记。
    send('ContentPart', { type: 'think', think: 'internal' })
    expect(parser.result().finalText).toBe('第2轮准备调用工具')
    send('ContentPart', { type: 'text', text: '最终' })
    send('ContentPart', { type: 'text', text: '答案' })
    send('TurnEnd', {})
    expect(parser.result()).toMatchObject({ ok: true, finalText: '最终答案', usage: { inputTokens: 31, outputTokens: 8, cachedTokens: 4 } })
    expect(events.filter(e => e.type === 'tool_call' && e.output === 'body')).toHaveLength(2)
    expect(events.filter(e => e.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 23, outputTokens: 6, cachedTokens: 2 } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, cachedTokens: 2 } },
    ])
  })

  it('同一步用量快照只记新增部分，下降快照明确失败而不猜测新 step', () => {
    const parser = createKimiCliParser()
    parser.onLine('{"type":"StepBegin","payload":{"n":1}}')
    const status = (output: number) => parser.onLine(JSON.stringify({ type: 'StatusUpdate', payload: {
      token_usage: { input_other: 5, input_cache_read: 1, input_cache_creation: 0, output },
    } }))
    status(2)
    status(4)
    expect(parser.result().usage).toEqual({ inputTokens: 6, outputTokens: 4, cachedTokens: 1 })
    status(1)
    parser.onLine('{"type":"TurnEnd","payload":{}}')
    expect(parser.result()).toMatchObject({ ok: false, error: expect.stringContaining('decreasing snapshot') })
  })

  it.each([
    { choices: [{ message: { role: 'assistant', content: 'unknown envelope' }, finish_reason: 'stop' }] },
    { type: 'event', payload: { type: 'TurnEnd' } },
    { type: 'TurnEnd', payload: {} },
    { role: 'assistant', content: 'partial', finish_reason: 'length' },
    { role: 'assistant', content: null },
  ])('未知封装或不完整 message 不猜测成功 %j', line => {
    const parser = createKimiCliParser()
    parser.onLine(JSON.stringify(line))
    expect(parser.result().ok).toBe(false)
  })

  it('中断不可被 TurnEnd 洗白，保留错误分类', () => {
    const parser = createKimiCliParser()
    parser.onLine('{"type":"TurnBegin","payload":{}}')
    parser.onLine('{"type":"StepInterrupted","payload":{"message":"429 rate limit"}}')
    parser.onLine('{"type":"TurnEnd","payload":{}}')
    expect(parser.result()).toMatchObject({ ok: false, error: expect.stringContaining('429 rate limit') })
  })

  it('不补造不完整 token_usage，Wire 中的完整 message 仍需 TurnEnd', () => {
    const parser = createKimiCliParser()
    parser.onLine('{"type":"TurnBegin","payload":{}}')
    parser.onLine('{"role":"assistant","content":"partial"}')
    parser.onLine('{"type":"StatusUpdate","payload":{"token_usage":{"output":5}}}')
    expect(parser.result().ok).toBe(false)
    expect(parser.result().usage).toBeUndefined()
  })
})
