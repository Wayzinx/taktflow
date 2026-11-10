import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHarnesses, createPiHarness, createTraeHarness } from './index.js'
import type { HarnessEvent } from '@taktflow/core'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture(pi = false) {
  const dir = await mkdtemp(join(tmpdir(), 'takt-pairing-cli-')); dirs.push(dir)
  const bin = join(dir, 'fake-cli.mjs'), capture = join(dir, 'capture.json')
  await writeFile(bin, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fake-cli'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
 const args = process.argv.slice(2), ext = args.indexOf('-e');
 writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, extension: ext < 0 ? undefined : readFileSync(args[ext + 1], 'utf8'), key: process.env.FAKE_KEY, bridge: process.env.TAKT_BRIDGE_TOKEN, noProxy: process.env.NO_PROXY }));
 const events = ${JSON.stringify(pi ? [{ type: 'session', id: 'p' }, { type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant' } }, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', usage: { input: 1, output: 1 } } }, { type: 'agent_end' }, { type: 'agent_settled', aborted: false }] : [{ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'error', message: '可恢复配置提示' } }, { type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }])};
 for (const event of events) console.log(JSON.stringify(event));
});
`, { mode: 0o700 })
  return { dir, bin, capture, read: async () => JSON.parse(await readFile(capture, 'utf8')) }
}
it('TRAE 注册、覆盖命令、自带模型不注入 provider、可恢复 error 提示', async () => {
  const f = await fixture()
  const h = createHarnesses({ config: { project: { name: '' }, workflows: [], harnessOverrides: { trae: { command: f.bin } } } }).trae!
  expect(h.displayName).toBe('TRAE CLI')
  expect(h.capabilities?.providerProtocols).toEqual(['openai-responses'])
  expect(await h.available()).toEqual({ ok: true })
  const events: HarnessEvent[] = []
  expect(await h.run({ cwd: f.dir, prompt: 'OK' }, e => events.push(e))).toMatchObject({ ok: true, finalText: 'OK' })
  expect((await f.read()).args.join(' ')).not.toContain('model_provider')
  expect(JSON.stringify(events)).toContain('可恢复配置提示')
})
it('TRAE provider 参数、context window、桥令牌脱敏且 NO_PROXY 传到子进程', async () => {
  const f = await fixture()
  const h = createTraeHarness({ bin: f.bin })
  await h.run({ cwd: f.dir, prompt: 'OK', model: 'model', modelConfig: { contextWindow: 100000 }, provider: { id: 'local', protocol: 'openai-responses', baseURL: 'http://127.0.0.1:1/r/x/v1', apiKeyEnv: 'TAKT_BRIDGE_TOKEN' }, env: { TAKT_BRIDGE_TOKEN: 'fake-bridge-token', NO_PROXY: '127.0.0.1,localhost' } }, () => {})
  const captured = await f.read()
  expect(captured.args).toContain('model_providers.local.wire_api="responses"')
  expect(captured.args).toContain('model_context_window=100000')
  expect(captured.args.join(' ')).not.toContain('fake-bridge-token')
  expect(captured.bridge).toBe('fake-bridge-token')
  expect(captured.noProxy).toBe('127.0.0.1,localhost')
})
it.each([
  ['openai-chat', 'openai-completions'], ['anthropic-messages', 'anthropic-messages'], ['openai-responses', 'openai-responses'], ['gemini', 'google-generative-ai'],
])('Pi %s 临时扩展、密钥只写变量名、参数注入、运行后清理', async (protocol, api) => {
  const f = await fixture(true), h = createPiHarness({ bin: f.bin, provider: 'old-config' })
  const result = await h.run({ cwd: f.dir, prompt: 'OK', model: 'model', modelConfig: { contextWindow: 9999 }, provider: { id: 'custom', protocol, baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', headers: { 'x-test': 'test' } }, env: { FAKE_KEY: 'synthetic-pi-api-secret' } }, () => {})
  expect(result).toMatchObject({ ok: true, finalText: 'OK' })
  const captured = await f.read()
  expect(captured.args).toContain('takt-custom')
  expect(captured.args).not.toContain('old-config')
  expect(captured.args).not.toContain('--no-extensions')
  expect(captured.extension).not.toContain('synthetic-pi-api-secret')
  expect(captured.key).toBe('synthetic-pi-api-secret')
  const registerProvider = (await import(`data:text/javascript,${encodeURIComponent(captured.extension)}`)).default
  let entry: unknown
  registerProvider({ registerProvider: (name: string, value: unknown) => { entry = { name, value } } })
  expect(entry).toEqual({ name: 'takt-custom', value: { baseUrl: 'http://127.0.0.1:1/v1', api, apiKey: '${FAKE_KEY}', headers: { 'x-test': 'test' }, models: [{ id: 'model', contextWindow: 9999 }] } })
  await expect(access(captured.args[captured.args.indexOf('-e') + 1])).rejects.toThrow()
})
it('Codex Chat 协议明确拒绝，不产生 wire_api=chat', async () => {
  const f = await fixture()
  const h = createHarnesses({ codex: { bin: f.bin } }).codex!
  expect(await h.run({ cwd: f.dir, prompt: '', provider: { id: 'chat', protocol: 'openai-chat' } }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('openai-responses') })
  await expect(access(f.capture)).rejects.toThrow()
})

it('TRAE 输出回显桥令牌时，事件、结果与 transcript 都脱敏', async () => {
  const f = await fixture(), transcript = join(f.dir, 'transcript.jsonl')
  await writeFile(f.bin, `#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => {
 console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.env.TAKT_BRIDGE_TOKEN } }));
 console.log(JSON.stringify({ type: 'turn.completed' }));
});\n`, { mode: 0o700 })
  const events: HarnessEvent[] = []
  const result = await createTraeHarness({ bin: f.bin }).run({ cwd: f.dir, prompt: 'OK', env: { TAKT_BRIDGE_TOKEN: 'synthetic-token-in-stdout', TAKT_TRANSCRIPT: transcript } }, e => events.push(e))
  expect(result).toMatchObject({ ok: true, finalText: '[REDACTED]' })
  expect(JSON.stringify(events)).not.toContain('synthetic-token-in-stdout')
  expect(await readFile(transcript, 'utf8')).not.toContain('synthetic-token-in-stdout')
})
