import { mkdtemp, readFile, rm, writeFile, symlink, mkdir, link } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { HarnessEvent, HarnessRequest } from '@taktflow/core'
import { createAcpHarness } from './index.js'
import { ACP_PRESETS, acpCommand } from './presets.js'
import { runHarnessConformance } from '../testing/conformance.js'

const script = fileURLToPath(new URL('../testing/fake-acp-agent.mjs', import.meta.url))
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture(scenario: Record<string, unknown> = {}, permissions?: 'allow' | 'reject') {
  const dir = await mkdtemp(join(tmpdir(), 'takt-acp-')); dirs.push(dir)
  const cwd = join(dir, 'work'); await mkdir(cwd)
  const workspace = join(dir, 'workspace'); await mkdir(workspace)
  const trace = join(dir, 'trace.jsonl'), pid = join(dir, 'pid')
  const harness = createAcpHarness({ id: 'acp', kind: 'acp', permissions, command: [process.execPath, script], env: {
    FAKE_ACP_SCENARIO: JSON.stringify(scenario), FAKE_ACP_TRACE: trace, FAKE_ACP_PID: pid,
  } }, { projectDir: cwd, handshakeTimeoutMs: 1000, cancelTimeoutMs: 60 })
  const events: HarnessEvent[] = []
  return { dir, cwd, workspace, trace, pid, harness, events,
    run: (req: Partial<HarnessRequest> = {}) => harness.run({ prompt: 'task', cwd, timeoutMs: 2000, ...req }, event => events.push(event)),
    messages: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  }
}

it('完整握手、消息与工具两拍；上下文不冒充 token 用量，思考不混入最终答案', async () => {
  const f = await fixture(); const result = await f.run()
  expect(result).toMatchObject({ ok: true, sessionId: 'fake-session', finalText: '完成' })
  expect(result.usage).toBeUndefined()
  expect(f.events.filter(event => event.type === 'tool_call')).toEqual([
    expect.objectContaining({ tool: 'read', callId: 'call-1', phase: 'start' }),
    expect.objectContaining({ tool: 'read', callId: 'call-1', phase: 'end', ok: true, durationMs: expect.any(Number) }),
  ])
  expect(f.events.filter(event => event.type === 'usage' || event.type === 'compacted')).toEqual([])
  for (const tag of ['thought', 'plan', 'usage_update', 'compaction']) expect(JSON.stringify(f.events)).toContain(`[ACP ${tag}]`)
  const calls = await f.messages()
  expect(calls.map(call => call.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
  expect(calls[0].params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } } })
  expect(calls[1].params).toEqual({ cwd: f.cwd, mcpServers: [] })
  expect(() => process.kill(Number(readFileSync(f.pid)), 0)).toThrow()
})

it('available 并发只握手一次并缓存，detail 包含真实 agent 与协议', async () => {
  const f = await fixture()
  const values = await Promise.all([f.harness.available(), f.harness.available()])
  expect(values[0]).toEqual(values[1]); expect(values[0].ok).toBe(true)
  expect(JSON.parse(values[0].detail!)).toMatchObject({ name: 'fake-acp', version: 'test-1', protocolVersion: 1 })
  await f.harness.available()
  expect((await f.messages()).map(call => call.method)).toEqual(['initialize'])
  expect(f.harness.capabilities?.resume).toBe(true)
})

it.each(['max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'unexpected'])('stopReason %s 不误报成功', async stopReason => {
  const f = await fixture({ stopReason }); expect(await f.run()).toMatchObject({ ok: false, error: expect.stringContaining(stopReason) })
})

it.each([{ crash: true }, { crashInit: true }, { badJson: true }, { version: 2 }, { handshakeHang: true }, { wrongSession: true }])('进程与协议失败有中文诊断 %j', async scenario => {
  const f = await fixture(scenario); const result = await f.run()
  expect(result.ok).toBe(false); expect(result.error).toMatch(/ACP/); expect(result.error).toMatch(/[\u4e00-\u9fff]/)
})

it('诊断分开"不是 JSON"和"处理不了"，空行跳过', async () => {
  expect((await (await fixture({ badJson: true })).run()).error).toContain('收到「not-json」')
  expect((await (await fixture({ wrongSession: true })).run()).error).toContain('ACP 消息处理失败：ACP 会话更新不匹配')
  expect(await (await fixture({ blankLines: true })).run()).toMatchObject({ ok: true })
})

it('agent RPC 错误与输出脱敏，不回传环境密钥', async () => {
  const f = await fixture({ rpcError: 'synthetic-acp-key-value' })
  const result = await f.run({ env: { API_KEY: 'synthetic-acp-key-value' } })
  expect(result.error).toContain('[REDACTED]'); expect(JSON.stringify(result)).not.toContain('synthetic-acp-key-value')
  const g = await fixture({ text: 'synthetic-acp-key-value' })
  const answer = await g.run({ env: { API_KEY: 'synthetic-acp-key-value' } })
  expect(answer.finalText).toBe('[REDACTED]'); expect(JSON.stringify(g.events)).not.toContain('synthetic-acp-key-value')
})

it.each([false, true])('取消通知与进程组回收，agent 忽略取消=%s', async ignoreCancel => {
  const f = await fixture({ hang: true, ignoreCancel, ignoreTerm: ignoreCancel })
  const controller = new AbortController()
  const result = await f.harness.run({ prompt: 'x', cwd: f.cwd, signal: controller.signal, timeoutMs: 2000 }, event => {
    if (event.type === 'message' && event.text === 'ready') controller.abort()
  })
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
  expect((await f.messages()).at(-1).method).toBe('session/cancel')
  expect(() => process.kill(Number(readFileSync(f.pid)), 0)).toThrow()
})

it('运行超时先取消 prompt，启动前取消不生成进程', async () => {
  const f = await fixture({ hang: true })
  expect(await f.run({ timeoutMs: 300 })).toMatchObject({ ok: false, error: expect.stringContaining('timeout') })
  expect((await f.messages()).at(-1).method).toBe('session/cancel')
  const g = await fixture(); const controller = new AbortController(); controller.abort()
  expect(await g.run({ signal: controller.signal })).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
  await expect(readFile(g.trace)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([{ loadSession: true }, { sessionCapabilities: { resume: {} } }, {}])('依据声明续会话 %j', async capabilities => {
  const f = await fixture({ capabilities }); const result = await f.run({ sessionId: 'fake-session' })
  const methods = (await f.messages()).map(call => call.method)
  if (!Object.keys(capabilities).length) { expect(result.ok).toBe(false); expect(methods).toEqual(['initialize']) }
  else { expect(result).toMatchObject({ ok: true, finalText: '完成' }); expect(methods[1]).toBe('loadSession' in capabilities ? 'session/load' : 'session/resume') }
})

const configOptions = [
  { id: 'model-id', category: 'model', name: 'Model', type: 'select', currentValue: 'old', options: [{ group: 'g', name: 'group', options: [{ value: 'new', name: 'New' }] }] },
  { id: 'reasoning', category: 'thought_level', name: 'Effort', type: 'select', currentValue: 'low', options: [{ value: 'high', name: 'High' }] },
]
it.each([false, true])('模型 effort 只记录服务端确认的值，忽略设置=%s', async ignoreConfig => {
  const f = await fixture({ configOptions, ignoreConfig }); await f.run({ model: 'new', effort: 'high' })
  expect((await f.messages()).filter(call => call.method === 'session/set_config_option').map(call => call.params)).toEqual([
    { sessionId: 'fake-session', configId: 'model-id', value: 'new' }, { sessionId: 'fake-session', configId: 'reasoning', value: 'high' },
  ])
  expect(f.events.find(event => event.type === 'started')).toMatchObject({ model: ignoreConfig ? 'old' : 'new', effort: ignoreConfig ? 'low' : 'high' })
  expect(JSON.stringify(f.events)).toContain(`\\"applied\\":${!ignoreConfig}`)
})
it('不支持的 model/effort 明确 applied:false，无伪造 reported', async () => {
  const f = await fixture(); await f.run({ model: 'new', effort: 'high' })
  expect(f.events.find(event => event.type === 'started')).toMatchObject({ model: undefined, effort: undefined })
  expect((await f.messages()).some(call => call.method === 'session/set_config_option')).toBe(false)
  expect(JSON.stringify(f.events)).toContain('\\"applied\\":false')
})

it('文件读写、公共存放区、路径穿越与符号链接及硬链接逃逸', async () => {
  const f = await fixture()
  const outside = join(f.dir, 'outside'); await writeFile(outside, 'outside')
  const inside = join(f.cwd, 'a.txt'); await writeFile(inside, 'one\ntwo\nthree\n')
  await symlink(outside, join(f.cwd, 'escape')); await symlink(f.dir, join(f.cwd, 'escape-dir'))
  await link(outside, join(f.cwd, 'hard'))
  const requests = [
    { method: 'fs/read_text_file', params: { path: inside, line: 2, limit: 1 } },
    { method: 'fs/write_text_file', params: { path: join(f.workspace, 'out'), content: 'saved' } },
    ...[outside, join(f.cwd, 'escape'), join(f.cwd, 'escape-dir', 'new'), join(f.cwd, '..', 'outside'), join(f.cwd, 'hard')].map(path => ({ method: 'fs/write_text_file', params: { path, content: 'bad' } })),
    { method: 'fs/read_text_file', params: { path: join(f.cwd, 'escape') } },
    { method: 'fs/read_text_file', params: { path: inside, sessionId: 'wrong' } },
    { method: 'terminal/create', params: { command: 'ls' } },
  ]
  const result = await f.run({ env: { TAKT_WORKSPACE: f.workspace, FAKE_ACP_SCENARIO: JSON.stringify({ requests }) } })
  expect(result.ok).toBe(true)
  const replies = JSON.parse(result.finalText)
  expect(replies[0].result.content).toBe('two'); expect(replies[1].result).toEqual({})
  expect(replies.slice(2).every((reply: { error: unknown }) => !!reply.error)).toBe(true)
  expect(replies.at(-1).error.code).toBe(-32601)
  expect(await readFile(outside, 'utf8')).toBe('outside'); expect(await readFile(join(f.workspace, 'out'), 'utf8')).toBe('saved')
})

const permission = (path: string, kind = 'edit') => ({ method: 'session/request_permission', params: {
  toolCall: { toolCallId: 'permission-1', title: 'edit', kind, locations: [{ path }] },
  options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
} })
it.each([
  { policy: 'allow', readOnly: false, kind: 'edit', allowed: true },
  { policy: 'reject', readOnly: false, kind: 'read', allowed: false },
  { policy: 'allow', readOnly: true, kind: 'edit', allowed: false },
  { policy: 'allow', readOnly: true, kind: 'execute', allowed: false },
  { policy: 'allow', readOnly: true, kind: 'read', allowed: true },
] as const)('权限策略 %j', async test => {
  const f = await fixture({}, test.policy)
  const result = await f.run({ readOnly: test.readOnly, env: { FAKE_ACP_SCENARIO: JSON.stringify({ requests: [permission(join(f.cwd, 'a'), test.kind)] }) } })
  expect(JSON.parse(result.finalText)[0].result.outcome).toEqual({ outcome: 'selected', optionId: test.allowed ? 'yes' : 'no' })
  expect(f.events.some(event => event.type === 'message' && event.text.startsWith('[ACP permission]'))).toBe(true)
})
it('越界权限与只读写请求被拒绝，每次权限留痕', async () => {
  const f = await fixture()
  const result = await f.run({ readOnly: true, env: { FAKE_ACP_SCENARIO: JSON.stringify({ requests: [permission(join(f.dir, 'outside'), 'read'),
    { method: 'fs/write_text_file', params: { path: join(f.cwd, 'out'), content: 'bad' } }] }) } })
  const replies = JSON.parse(result.finalText)
  expect(replies[0].result.outcome.optionId).toBe('no'); expect(replies[1].error).toBeDefined()
  await expect(readFile(join(f.cwd, 'out'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('预设命令可覆盖；缺失命令与未知预设明确报错', () => {
  expect(ACP_PRESETS.map(preset => preset.id)).toEqual(['gemini', 'claude', 'codex', 'opencode', 'qwen', 'kimi', 'goose', 'copilot'])
  expect(acpCommand({ id: 'x', kind: 'acp', preset: 'gemini' })).toEqual(ACP_PRESETS[0]!.command)
  expect(acpCommand({ id: 'x', kind: 'acp', preset: 'unknown', command: ['local'] })).toEqual(['local'])
  expect(() => acpCommand({ id: 'x', kind: 'acp', preset: 'unknown' })).toThrow('command')
})

const source = { kind: 'synthetic' as const, description: '离线 ACP v1 schema 合成；本地 JSON-RPC agent，无模型调用' }
runHarnessConformance<Record<string, unknown>>('ACP', {
  parse: async (scenario, emit, req) => createAcpHarness({ id: 'acp', kind: 'acp', command: [process.execPath, script], env: { FAKE_ACP_SCENARIO: JSON.stringify(scenario) } }).run(req, emit),
  fixtures: {
    success: { name: '完整一轮', source, input: {}, expected: { started: { type: 'started', sessionId: 'fake-session' },
      message: { type: 'message', role: 'assistant', text: '完成' }, toolCall: { type: 'tool_call', tool: 'read', input: '{"path":"a.ts"}', phase: 'end', callId: 'call-1', ok: true }, finalText: '完成', sessionId: 'fake-session' } },
    structured: { name: 'JSON 最终输出', source, input: { text: '```json\n{"verdict":"pass"}\n```' }, schema: { type: 'object' }, expected: { verdict: 'pass' } },
    errors: [{ name: '拒绝', source, input: { stopReason: 'refusal' }, keywords: ['refusal'] }],
  },
  runtime: { create: bin => createAcpHarness({ id: 'acp', kind: 'acp', command: [bin] }, { handshakeTimeoutMs: 60_000 }) },
})

it('失败握手也缓存；过期后重新探测，缺失命令返回中文原因', async () => {
  const f = await fixture({ version: 2 })
  expect((await f.harness.available()).ok).toBe(false)
  await f.harness.available()
  expect(await f.messages()).toHaveLength(1)
  const harness = createAcpHarness({ id: 'x', kind: 'acp', command: [process.execPath, script], env: { FAKE_ACP_TRACE: f.trace } }, { projectDir: f.cwd, cacheMs: 0 })
  await harness.available(); await harness.available()
  expect(await f.messages()).toHaveLength(3)
  expect(await createAcpHarness({ id: 'x', kind: 'acp', command: [join(f.dir, 'missing')] }).available()).toMatchObject({ ok: false, reason: expect.stringContaining('命令路径') })
})

it('取消回收继承输出管道且忽略 SIGTERM 的后代进程', async () => {
  const f = await fixture()
  const descendant = join(f.dir, 'child-pid')
  const controller = new AbortController()
  const result = await f.harness.run({ prompt: 'x', cwd: f.cwd, signal: controller.signal, timeoutMs: 2000,
    env: { FAKE_ACP_SCENARIO: JSON.stringify({ hang: true, ignoreCancel: true, descendant }) } }, event => {
    if (event.type === 'message' && event.text === 'ready') controller.abort()
  })
  expect(result.ok).toBe(false)
  const pid = Number(await readFile(descendant, 'utf8'))
  expect(pid).toBeGreaterThan(0)
  expect(() => process.kill(pid, 0)).toThrow()
})

it('没有 allow_once 时不能误选 allow_always；无路径与错误会话的权限也留痕', async () => {
  const f = await fixture()
  const call = permission(join(f.cwd, 'a'))
  const result = await f.run({ env: { FAKE_ACP_SCENARIO: JSON.stringify({ requests: [
    { ...call, params: { ...call.params, options: [{ optionId: 'always', kind: 'allow_always', name: 'Always' }] } },
    { ...call, params: { ...call.params, toolCall: { toolCallId: 'no-path', kind: 'read' } } },
    { ...call, params: { ...call.params, sessionId: 'wrong' } },
  ] }) } })
  const replies = JSON.parse(result.finalText)
  expect(replies[0].result.outcome).toEqual({ outcome: 'cancelled' })
  expect(replies[1].result.outcome.optionId).toBe('no')
  expect(replies[2].error.code).toBe(-32602)
  expect(f.events.filter(event => event.type === 'message' && event.text.startsWith('[ACP permission]'))).toHaveLength(3)
})

it('claude 预设能改接 anthropic 协议的 API：地址、令牌、模型走环境变量，started 报实际模型；其他预设明确拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-acp-')); dirs.push(dir)
  const echoEnv = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN']
  const configOptions = [{ id: 'model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus' }] }]
  const create = (preset: string) => createAcpHarness({ id: preset, kind: 'acp', preset, command: [process.execPath, script],
    env: { FAKE_ACP_SCENARIO: JSON.stringify({ echoEnv, configOptions }), FAKE_ACP_TRACE: join(dir, `${preset}.jsonl`) } }, { projectDir: dir, handshakeTimeoutMs: 1000 })
  const provider = { id: 'ds', protocol: 'anthropic-messages', baseURL: 'https://ds.invalid/anthropic', apiKeyEnv: 'TAKT_ACP_DS_KEY' }
  const claude = create('claude')
  expect(claude.capabilities).toMatchObject({ customProvider: true, providerProtocols: ['anthropic-messages'] })
  const events: HarnessEvent[] = []
  const result = await claude.run({ prompt: 'x', cwd: dir, timeoutMs: 2000, model: 'ds-flash', provider, env: { TAKT_ACP_DS_KEY: 'fake-ds-key-123' } }, e => events.push(e))
  expect(result.ok).toBe(true)
  expect(result.finalText).not.toContain('fake-ds-key-123')
  expect(JSON.parse(result.finalText)).toMatchObject({ ANTHROPIC_BASE_URL: 'https://ds.invalid/anthropic', ANTHROPIC_MODEL: 'ds-flash', CLAUDE_CODE_OAUTH_TOKEN: '' })
  expect(events).toContainEqual(expect.objectContaining({ type: 'started', model: 'ds-flash' }))
  const sent = (await readFile(join(dir, 'claude.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(sent.some(m => m.method === 'session/set_config_option')).toBe(false)
  expect(sent.find(m => m.method === 'session/new')?.params._meta).toEqual({ claudeCode: { options: { settingSources: ['project', 'local'] } } })
  expect(await claude.run({ prompt: 'x', cwd: dir, timeoutMs: 2000, model: 'ds-flash', provider }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('TAKT_ACP_DS_KEY') })

  const gemini = create('gemini')
  expect(gemini.capabilities.customProvider).toBe(false)
  expect(await gemini.run({ prompt: 'x', cwd: dir, timeoutMs: 2000, provider }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('不支持改接模型 API') })
})

it('引擎给的本机沙箱照常运行并带上沙箱环境变量；真隔离沙箱明确拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-acp-')); dirs.push(dir)
  const harness = createAcpHarness({ id: 'acp', kind: 'acp', command: [process.execPath, script],
    env: { FAKE_ACP_SCENARIO: JSON.stringify({ echoEnv: ['TAKT_NODE'] }) } }, { projectDir: dir, handshakeTimeoutMs: 1000 })
  const sandbox = (provider: string) => ({ id: 's', provider, spec: { env: { TAKT_NODE: 'clarify' } } }) as unknown as HarnessRequest['sandbox']
  const ok = await harness.run({ prompt: 'x', cwd: dir, timeoutMs: 2000, sandbox: sandbox('local') }, () => {})
  expect(ok.ok).toBe(true)
  expect(JSON.parse(ok.finalText)).toEqual({ TAKT_NODE: 'clarify' })
  expect(await harness.run({ prompt: 'x', cwd: dir, timeoutMs: 2000, sandbox: sandbox('bwrap') }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('bwrap 沙箱') })
})
