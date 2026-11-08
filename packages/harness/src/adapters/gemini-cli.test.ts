import { describe, expect, it } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createGeminiCliParser } from './gemini-cli.js'

// 按设计表事件名构造的合成样例；未由真实 Gemini CLI 录制。
describe('Gemini CLI 合成协议', () => {
  it('解析开始、消息快照/增量、工具关联及累计用量', () => {
    const events: HarnessEvent[] = []
    const parser = createGeminiCliParser(e => events.push(e))
    const lines = [
      { type: 'init', session_id: 'g1', model: 'gemini-test' },
      { type: 'message', role: 'user', content: '问题' },
      { type: 'message', role: 'assistant', content: '草稿' },
      { type: 'tool_use', tool_id: 't1', tool_name: 'read_file', parameters: { path: 'a' } },
      { type: 'tool_use', tool_id: 't2', tool_name: 'shell', parameters: { command: 'false' } },
      { type: 'tool_result', tool_id: 't2', status: 'error', output: 'exit 1' },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'body' },
      { type: 'message', role: 'assistant', content: '完' },
      { type: 'message', role: 'assistant', delta: true, content: '成' },
      { type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 3, cached: 2 } },
    ]
    lines.forEach(line => parser.onLine(JSON.stringify(line)))
    expect(parser.result()).toEqual({ ok: true, finalText: '完成', sessionId: 'g1', usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 2 } })
    expect(events).toContainEqual({ type: 'started', sessionId: 'g1', model: 'gemini-test' })
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '成' })
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'read_file', input: '{"path":"a"}', output: 'body', ok: true })
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'shell', input: '{"command":"false"}', output: 'exit 1', ok: false })
    expect(events).toContainEqual({ type: 'usage', usage: parser.result().usage })
  })

  it('只有明确 success 才完成，不补造缺失 usage', () => {
    const parser = createGeminiCliParser()
    parser.onLine('{"type":"result","stats":{"input_tokens":1}}')
    expect(parser.result().ok).toBe(false)
    expect(parser.result().usage).toBeUndefined()
    parser.onLine('{"type":"result","status":"success"}')
    expect(parser.result().ok).toBe(true)
  })

  it('错误 result 保留分类关键词，后续成功不洗白', () => {
    const parser = createGeminiCliParser()
    parser.onLine('{"type":"result","status":"error","error":{"code":401,"message":"sign in"}}')
    parser.onLine('{"type":"result","status":"success"}')
    expect(parser.result()).toMatchObject({ ok: false, error: expect.stringContaining('401') })
    expect(parser.result().error).toContain('sign in')
  })
})
