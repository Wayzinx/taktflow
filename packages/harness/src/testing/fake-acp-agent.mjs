import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

// 合成 ACP v1 agent：不访问模型或网络；测试通过环境变量选择故障与请求脚本。
const scenario = JSON.parse(process.env.FAKE_ACP_SCENARIO ?? '{}')
const sessionId = 'fake-session'
const pending = new Map()
let nextId = 0
let promptId
let configOptions = scenario.configOptions ?? []
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const respond = (id, result) => send({ id, result })
const update = value => send({ method: 'session/update', params: { sessionId, update: value } })
const trace = data => { if (process.env.FAKE_ACP_TRACE) appendFileSync(process.env.FAKE_ACP_TRACE, `${JSON.stringify(data)}\n`) }
const request = (method, params) => new Promise(resolve => { const id = `agent-${++nextId}`; pending.set(id, resolve); send({ id, method, params: { sessionId, ...params } }) })
if (process.env.FAKE_ACP_PID) writeFileSync(process.env.FAKE_ACP_PID, String(process.pid))
if (scenario.ignoreTerm) process.on('SIGTERM', () => {})
if (scenario.descendant) {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'inherit' })
  writeFileSync(scenario.descendant, String(child.pid))
}
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (!message.method) { const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message); return }
  trace(message)
  const { method, id, params } = message
  if (method === 'initialize') {
    if (scenario.handshakeHang) return
    if (scenario.crashInit) process.exit(17)
    if (scenario.badJson) { process.stdout.write('not-json\n'); return }
    respond(id, { protocolVersion: scenario.version ?? 1, agentInfo: { name: 'fake-acp', version: 'test-1' },
      agentCapabilities: scenario.capabilities ?? { loadSession: true, sessionCapabilities: { resume: {} } } })
  } else if (['session/new', 'session/load', 'session/resume'].includes(method)) {
    if (method === 'session/load') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '历史消息' } })
    respond(id, { ...(method === 'session/new' ? { sessionId } : {}), configOptions })
  } else if (method === 'session/set_config_option') {
    if (!scenario.ignoreConfig) configOptions = configOptions.map(option => option.id === params.configId ? { ...option, currentValue: params.value } : option)
    respond(id, { configOptions })
  } else if (method === 'session/prompt') {
    promptId = id
    if (scenario.crash) process.exit(23)
    if (scenario.rpcError) { send({ id, error: { code: -32000, message: scenario.rpcError } }); return }
    if (scenario.wrongSession) { send({ method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'plan', entries: [] } } }); return }
    if (scenario.hang) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } }); return }
    if (scenario.updates) for (const value of scenario.updates) update(value)
    else {
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: '读取文件', kind: 'read', status: 'pending', rawInput: { path: 'a.ts' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: { content: 'source' } })
      update({ sessionUpdate: 'plan', entries: [{ content: '验证', priority: 'high', status: 'completed' }] })
      update({ sessionUpdate: 'usage_update', used: 120, size: 1000, cost: { amount: 0.01, currency: 'USD' } })
      update({ sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'in_progress' })
      update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'compact-1', content: { type: 'text', text: '摘要' } })
      update({ sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'completed' })
    }
    const replies = []
    for (const call of scenario.requests ?? []) replies.push(await request(call.method, call.params))
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: scenario.requests ? JSON.stringify(replies) : scenario.text ?? '完成' } })
    respond(id, { stopReason: scenario.stopReason ?? 'end_turn' })
  } else if (method === 'session/cancel') {
    if (!scenario.ignoreCancel && promptId !== undefined) respond(promptId, { stopReason: 'cancelled' })
  } else send({ id, error: { code: -32601, message: 'unknown' } })
})
