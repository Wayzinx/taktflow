import { describe, expect, it } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createClaudeCodeParser } from '../claude-code.js'
import { createCodexParser } from '../codex.js'
import { createDshParser } from '../dsh.js'

// 2026-11-04 已有本机脱敏实录，从对应 root *.test.ts 的 recordedFixture 原样复制。
// 这些录制仅属于 Claude Code / Codex / DSH；不能用于证明新 CLI 的版本兼容性。

// 来源：../claude-code.test.ts recordedFixture
const claudeRecording = `{"type":"system","subtype":"init","session_id":"recorded-id"}
{"type":"assistant","session_id":"recorded-id","message":{"role":"assistant","type":"message","content":[{"type":"text","text":"[recorded text omitted]"}]},"error":"[recorded text omitted]"}
{"type":"result","subtype":"success","session_id":"recorded-id","result":"[recorded text omitted]","is_error":true,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"total_cost_usd":0}`

// 来源：../codex.test.ts recordedFixture
const codexRecording = `{"type":"thread.started","thread_id":"recorded-id"}
{"type":"item.completed","item":{"id":"recorded-id","type":"error","message":"[recorded text omitted]"}}
{"type":"item.completed","item":{"id":"recorded-id","type":"error","message":"[recorded text omitted]"}}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"recorded-id","type":"agent_message","text":"TAKTFLOW_HARNESS_PROBE_OK"}}
{"type":"turn.completed","usage":{"input_tokens":13799,"cached_input_tokens":13440,"cache_write_input_tokens":0,"output_tokens":14,"reasoning_output_tokens":0}}`

// 来源：../dsh.test.ts recordedFixture
const dshRecording = `{"type":"session","sessionId":"recorded-id"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"Sign in","code":"ACCOUNT_SIGN_IN_REQUIRED"}}}
{"type":"final","text":"[recorded text omitted]"}`


describe('2026-11-04 历史脱敏实录回放（非本次 CLI 在线执行）', () => {
  it('Claude Code: subtype=success 保留 is_error=true 的失败语义', () => {
    const events: HarnessEvent[] = []
    const parser = createClaudeCodeParser(event => events.push(event))
    claudeRecording.split('\n').forEach(line => parser.onLine(line))
    expect(parser.result()).toMatchObject({ ok: false, sessionId: 'recorded-id',
      finalText: '[recorded text omitted]', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 } })
    expect(parser.result().error).toMatch(/^Claude Code：/)
    expect(events).toContainEqual({ type: 'started', sessionId: 'recorded-id', model: undefined })
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '[recorded text omitted]' })
  })

  it('Codex: 两条可恢复 item.error 不覆盖终态成功及原始 token 用量', () => {
    const events: HarnessEvent[] = []
    const parser = createCodexParser(event => events.push(event))
    codexRecording.split('\n').forEach(line => parser.onLine(line))
    expect(parser.result()).toMatchObject({ ok: true, sessionId: 'recorded-id',
      finalText: 'TAKTFLOW_HARNESS_PROBE_OK', usage: { inputTokens: 13799, outputTokens: 14, cachedTokens: 13440 } })
    expect(parser.result().error).toBeUndefined()
    expect(events.filter(event => event.type === 'message' && event.role === 'system'
      && event.text.includes('"type":"error"'))).toHaveLength(2)
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 13799, outputTokens: 14, cachedTokens: 13440 } })
  })

  it('DSH: 登录失败保留 ACCOUNT_SIGN_IN_REQUIRED / Sign in，不补造缺失用量', () => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    dshRecording.split('\n').forEach(line => parser.onLine(line))
    expect(parser.result()).toMatchObject({ ok: false, sessionId: 'recorded-id', finalText: '[recorded text omitted]' })
    expect(parser.result().usage).toBeUndefined()
    expect(parser.result().error).toContain('ACCOUNT_SIGN_IN_REQUIRED')
    expect(parser.result().error).toContain('Sign in')
    expect(events).toContainEqual({ type: 'started', sessionId: 'recorded-id', model: undefined })
  })
})
