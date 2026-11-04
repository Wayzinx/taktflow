import { describe, expect, it } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createOpenCodeParser } from './opencode.js'

// part.text / part.tokens 的合成样例，不是 OpenCode CLI 录制。
describe('OpenCode 合成协议', () => {
  it('逐步骤汇总 usage/cost，工具步骤不提前成功，同 ID 完成事件不重复计费', () => {
    const events: HarnessEvent[] = []
    const parser = createOpenCodeParser(e => events.push(e))
    const send = (value: unknown) => parser.onLine(JSON.stringify(value))
    send({ type: 'step_start', sessionID: 'o1', part: { type: 'step-start' } })
    send({ type: 'tool_use', part: { callID: 't1', tool: 'read', state: { status: 'completed', input: { path: 'a' }, output: 'body' } } })
    const finish = { type: 'step_finish', part: { id: 'p1', reason: 'tool-calls', cost: 0.01, tokens: { input: 10, output: 2, cache: { read: 4, write: 1 } } } }
    send(finish)
    send(finish)
    expect(parser.result().ok).toBe(false)
    send({ type: 'step_start', sessionID: 'o1' })
    send({ type: 'text', part: { text: '完成' } })
    send({ type: 'step_finish', part: { id: 'p2', reason: 'stop', cost: 0.02, tokens: { input: 12, output: 3, cache: { read: 5 } } } })
    expect(parser.result()).toEqual({ ok: true, sessionId: 'o1', finalText: '完成', usage: { inputTokens: 22, outputTokens: 5, cachedTokens: 9, costUsd: 0.03 } })
    expect(events.filter(e => e.type === 'started')).toHaveLength(1)
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '完成' })
    expect(events).toContainEqual({ type: 'tool_call', tool: 'read', input: '{"path":"a"}', output: 'body', ok: true })
    expect(events.filter(e => e.type === 'usage')).toHaveLength(2)
  })

  it.each(['tool-calls', 'length', 'unknown', undefined])('非正常结束原因 %s 不能成功', reason => {
    const parser = createOpenCodeParser()
    parser.onLine(JSON.stringify({ type: 'step_finish', part: { reason, tokens: { input: 1 } } }))
    expect(parser.result()).toMatchObject({ ok: false })
    expect(parser.result().usage).toBeUndefined()
  })

  it('两轮工具往返后只保留最新 step 的文本，step 内 chunks 拼接', () => {
    const events: HarnessEvent[] = []
    const parser = createOpenCodeParser(e => events.push(e))
    const send = (value: unknown) => parser.onLine(JSON.stringify(value))
    for (const n of [1, 2]) {
      send({ type: 'step_start', sessionID: 'o2' })
      send({ type: 'text', part: { text: `第${n}轮准备` } })
      send({ type: 'text', part: { text: '调用工具' } })
      send({ type: 'tool_use', part: { callID: `t${n}`, tool: 'read', state: { status: 'completed', input: { path: 'a' }, output: 'body' } } })
      send({ type: 'step_finish', part: { id: `p${n}`, reason: 'tool-calls', tokens: { input: 10, output: 2 } } })
      expect(parser.result().ok).toBe(false)
    }
    expect(parser.result().finalText).toBe('第2轮准备调用工具')
    send({ type: 'step_start', sessionID: 'o2' })
    expect(parser.result().finalText).toBe('第2轮准备调用工具')
    send({ type: 'text', part: { text: '最终' } })
    send({ type: 'text', part: { text: '答案' } })
    send({ type: 'step_finish', part: { id: 'p3', reason: 'stop', tokens: { input: 5, output: 3 } } })
    expect(parser.result()).toMatchObject({ ok: true, finalText: '最终答案', usage: { inputTokens: 25, outputTokens: 7 } })
    expect(events.filter(e => e.type === 'tool_call' && e.output === 'body')).toHaveLength(2)
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '第1轮准备' })
  })

  it('新的步骤撤回完成状态，错误事件保留嵌套诊断', () => {
    const parser = createOpenCodeParser()
    parser.onLine('{"type":"step_finish","part":{"reason":"stop"}}')
    expect(parser.result().ok).toBe(true)
    parser.onLine('{"type":"step_start","sessionID":"o1"}')
    expect(parser.result().ok).toBe(false)
    parser.onLine('{"type":"error","error":{"name":"APIError","data":{"statusCode":503,"message":"overloaded"}}}')
    parser.onLine('{"type":"step_finish","part":{"reason":"stop"}}')
    expect(parser.result()).toMatchObject({ ok: false, error: expect.stringContaining('503') })
    expect(parser.result().error).toContain('overloaded')
  })
})
