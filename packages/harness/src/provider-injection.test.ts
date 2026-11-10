import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createAcpHarness, createDshHarness, createHarnesses, createOpenCodeHarness, createQwenCodeHarness, harnessCommand } from './index.js'
import type { HarnessRequest } from '@taktflow/core'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const fakeAcp = fileURLToPath(new URL('./testing/fake-acp-agent.mjs', import.meta.url))
async function fixture(acp = false, mode = 'ok') {
  const dir = await mkdtemp(join(tmpdir(), 'takt-injection-test-')); dirs.push(dir)
  const bin = join(dir, 'fake.mjs'), capture = join(dir, 'capture.json')
  await writeFile(bin, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), index = args.indexOf('--patch');
const file = index >= 0 ? args[index+1] : process.env.HERMES_HOME ? process.env.HERMES_HOME+'/config.yaml' : process.env.QWEN_HOME ? process.env.QWEN_HOME+'/settings.json' : undefined;
const env = Object.fromEntries(['TAKT_DSH_API_KEY','TAKT_OPENCODE_API_KEY','OPENCODE_CONFIG_CONTENT','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','TAKT_HERMES_API_KEY','QWEN_HOME','HERMES_HOME'].map(k=>[k,process.env[k]]));
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,env,file,config:file?readFileSync(file,'utf8'):undefined}));
${mode === 'crash' ? 'process.exit(3);' : mode === 'hang' ? 'setInterval(()=>{},1000);' : acp ? `await import(${JSON.stringify(fakeAcp)});` : `
console.log(JSON.stringify({type:'text',part:{text:'OK'}}));
console.log(JSON.stringify({type:'step_finish',part:{reason:'stop'}}));
console.log(JSON.stringify({type:'final',text:'OK'}));
console.log(JSON.stringify({type:'result',result:'OK',is_error:false}));`}
`, { mode: 0o700 })
  return { dir, bin, capture, read: async () => JSON.parse(await readFile(capture, 'utf8')) }
}
const request = (cwd: string, protocol = 'openai-chat'): HarnessRequest => ({ cwd, prompt: 'OK', model: 'vendor/model',
  provider: { id: 'p', protocol, baseURL: 'https://provider.example/v1', apiKeyEnv: 'TEST_API_KEY' }, env: { TEST_API_KEY: 'synthetic-injection-secret' } })

// 本机 2026-11-10：dsh --profile headless --patch <file> --dump-config，三协议注册、默认模型和 high 均合并成功；不发模型请求。
it.each([['openai-chat', 'openai-completions'], ['openai-responses', 'openai-responses'], ['anthropic-messages', 'anthropic-messages']])('dsh %s 注入 patch、只引用密钥环境变量、完成后删除', async (protocol, api) => {
  const f = await fixture(), h = createDshHarness({ bin: f.bin })
  expect(await h.run({ ...request(f.dir, protocol), effort: 'high' }, () => {})).toMatchObject({ ok: true })
  const seen = await f.read(), patch = JSON.parse(seen.config)
  expect(patch[0].config).toEqual({ provider: 'takt-runtime', model: 'vendor/model', reasoningEffort: 'high' })
  expect(patch[1].config.providers['takt-runtime']).toMatchObject({ api, apiKeyEnv: 'TAKT_DSH_API_KEY', baseURL: 'https://provider.example/v1' })
  expect(seen.env.TAKT_DSH_API_KEY).toBe('synthetic-injection-secret')
  expect(seen.config).not.toContain('synthetic-injection-secret')
  await expect(access(seen.file)).rejects.toThrow()
})

// refs/opencode: packages/cli/src/server-process.ts:133；packages/core/src/config.ts:291-302,366-376
// content 在项目配置后、管理策略前合并；config/variable.ts:25-38 支持 {env:VAR}。
// v1/config/migrate.ts:120-138 将 npm/options 转为 package/settings；commands/commands.ts:392 说明 provider/model。
it.each([['openai-chat', '@ai-sdk/openai-compatible'], ['anthropic-messages', '@ai-sdk/anthropic']])('OpenCode %s 的配置和模型参数', async (protocol, npm) => {
  const f = await fixture(), h = createOpenCodeHarness({ bin: f.bin })
  expect(await h.run(request(f.dir, protocol), () => {})).toMatchObject({ ok: true })
  const seen = await f.read(), config = JSON.parse(seen.env.OPENCODE_CONFIG_CONTENT)
  expect(config.provider['takt-runtime']).toMatchObject({ npm, options: { apiKey: '{env:TAKT_OPENCODE_API_KEY}', baseURL: 'https://provider.example/v1' } })
  expect(seen.args.slice(-2)).toEqual(['--model', 'takt-runtime/vendor/model'])
  expect(seen.env.TAKT_OPENCODE_API_KEY).toBe('synthetic-injection-secret')
  expect(seen.env.OPENCODE_CONFIG_CONTENT).not.toContain('synthetic-injection-secret')
})

// refs/qwen-code: packages/core/src/models/constants.ts:87-102 三协议环境变量；utils/auth-type.ts:8-16。
// packages/cli/src/config/config.ts:791,2311-2315,2401：显式 auth 优先，bare 排除已保存配置。
// packages/core/src/config/storage.ts:193-202：QWEN_HOME 隔离可写配置。
it.each(['openai-chat', 'openai-responses', 'anthropic-messages'])('Qwen CLI 与 ACP %s 使用相同注入并清理', async protocol => {
  for (const acp of [false, true]) {
    const f = await fixture(acp)
    const h = acp ? createAcpHarness({ id: 'q', kind: 'acp', preset: 'qwen', command: [f.bin] }) : createQwenCodeHarness({ bin: f.bin })
    expect(await h.run(request(f.dir, protocol), () => {})).toMatchObject({ ok: true })
    const seen = await f.read(), prefix = protocol === 'anthropic-messages' ? 'ANTHROPIC' : 'OPENAI'
    expect(seen.args).toContain('--bare')
    expect(seen.args[seen.args.indexOf('--auth-type') + 1]).toBe(protocol === 'anthropic-messages' ? 'anthropic' : protocol === 'openai-chat' ? 'openai' : protocol)
    expect(seen.env[`${prefix}_API_KEY`]).toBe('synthetic-injection-secret')
    expect(seen.env[`${prefix}_BASE_URL`]).toBe('https://provider.example/v1')
    expect(seen.env[`${prefix}_MODEL`]).toBe('vendor/model')
    expect(seen.config + seen.args.join(' ')).not.toContain('synthetic-injection-secret')
    await expect(access(seen.env.QWEN_HOME)).rejects.toThrow()
  }
})

// refs/hermes-agent: pyproject.toml:595；acp_adapter/session.py:522-560；hermes_constants.py:194-202。
// hermes_cli/runtime_provider_custom.py:150-179,738-766：命名 provider 的 base_url、key_env 与 chat_completions。
it('Hermes ACP 的临时配置和环境密钥；OpenClaw 仅声明自带', async () => {
  const f = await fixture(true), h = createAcpHarness({ id: 'hermes', kind: 'acp', preset: 'hermes', command: [f.bin] })
  expect(await h.run(request(f.dir), () => {})).toMatchObject({ ok: true })
  const seen = await f.read(), config = JSON.parse(seen.config)
  expect(config.model).toEqual({ provider: 'custom:takt-runtime', default: 'vendor/model' })
  expect(config.providers['takt-runtime']).toMatchObject({ key_env: 'TAKT_HERMES_API_KEY', api_mode: 'chat_completions' })
  expect(seen.config).not.toContain('synthetic-injection-secret')
  expect(seen.env.TAKT_HERMES_API_KEY).toBe('synthetic-injection-secret')
  await expect(access(seen.env.HERMES_HOME)).rejects.toThrow()
  const claw = createAcpHarness({ id: 'claw', kind: 'acp', preset: 'openclaw', command: [f.bin] })
  expect(claw.capabilities?.customProvider).toBe(false)
  expect(await claw.run(request(f.dir), () => {})).toMatchObject({ ok: false, error: expect.stringContaining('不支持') })
})

it.each(['crash', 'hang'])('临时配置在退出失败或启动后取消（%s）后清理，环境不会写回父进程', async mode => {
  for (const kind of ['dsh', 'qwen', 'hermes']) {
    const f = await fixture(kind === 'hermes', mode)
    const h = kind === 'dsh' ? createDshHarness({ bin: f.bin }) : kind === 'qwen' ? createQwenCodeHarness({ bin: f.bin }) : createAcpHarness({ id: kind, kind: 'acp', preset: kind, command: [f.bin] }, { handshakeTimeoutMs: 15000 })
    const before = process.env.TAKT_DSH_API_KEY
    const controller = new AbortController()
    // 等 fake bin 写下配置再取消，避免高负载下在进程启动前就超时。
    const poll = mode === 'hang' ? setInterval(() => { void access(f.capture).then(() => controller.abort()).catch(() => {}) }, 20) : undefined
    try { expect((await h.run({ ...request(f.dir), signal: controller.signal, timeoutMs: 15000 }, () => {})).ok).toBe(false) }
    finally { clearInterval(poll) }
    const seen = await f.read()
    await expect(access(seen.file)).rejects.toThrow()
    expect(process.env.TAKT_DSH_API_KEY).toBe(before)
  }
}, 60000)

it('缺密钥和错误协议在启动前拒绝；Claude ACP 同 ID 切换且不迁移自定义条目', async () => {
  const f = await fixture()
  for (const h of [createDshHarness({ bin: f.bin }), createQwenCodeHarness({ bin: f.bin }), createOpenCodeHarness({ bin: f.bin })]) {
    expect(await h.run({ ...request(f.dir), env: { TEST_API_KEY: '' } }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('TEST_API_KEY') })
    expect(await h.run(request(f.dir, 'unsupported'), () => {})).toMatchObject({ ok: false, error: expect.stringContaining('协议') })
  }
  await expect(access(f.capture)).rejects.toThrow()
  const acp = await fixture(true)
  const registry = createHarnesses({ config: { project: { name: '' }, workflows: [],
    harnessOverrides: { 'claude-code': { transport: 'acp', command: acp.bin } }, harnesses: [{ id: 'custom-claude', kind: 'acp', preset: 'claude' }] } })
  expect(registry['claude-code']?.id).toBe('claude-code')
  expect(registry['claude-code']?.capabilities).toMatchObject({ mcp: false, structuredOutput: false, customProvider: true })
  expect(harnessCommand(registry['claude-code']!)).toContain('--no-install')
  expect(await registry['claude-code']!.available()).toMatchObject({ ok: true, detail: expect.stringContaining('fake-acp') })
  expect(registry['custom-claude']).toBeDefined()
  expect(createHarnesses()['claude-code']?.capabilities?.mcp).toBe(true)
})
