import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createClaudeCodeHarness, createClaudeCodeParser } from './claude-code.js'
import { createCodexHarness, createTraeHarness } from './codex.js'
import type { HarnessEvent } from '@taktflow/core'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, note: { type: 'string' } } }
async function fake(kind: 'claude' | 'codex', value: unknown, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), 'takt-native-schema-')); roots.push(root)
  const bin = join(root, 'fake-cli'), captured = join(root, 'args.json')
  const lines = kind === 'claude'
    ? [{ type: 'result', subtype: 'success', structured_output: value, result: 'final', session_id: 'fake-session' }]
    : [{ type: 'thread.started', thread_id: 'fake-session' }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }, { type: 'turn.completed' }]
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst i = args.indexOf('--output-schema');\nfs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({args, schema: i >= 0 ? JSON.parse(fs.readFileSync(args[i+1], 'utf8')) : null}));\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { for (const line of ${JSON.stringify(lines)}) console.log(JSON.stringify(line)); process.exitCode = ${exitCode}; });\n`, { mode: 0o755 })
  return { root, bin, captured }
}
it.each([null, { ok: true }])('Claude CLI 传原 schema，structured_output=%j 按非 null 规则处理', async value => {
  const f = await fake('claude', value)
  const harness = createClaudeCodeHarness({ bin: f.bin })
  const result = await harness.run({ cwd: f.root, prompt: '任务', resultSchema: schema, readOnly: true }, () => {})
  const { args } = JSON.parse(await readFile(f.captured, 'utf8')) as { args: string[] }
  expect(harness.capabilities?.structuredOutput).toBe(true)
  expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(schema)
  expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Grep,Glob'])
  expect(result.ok).toBe(true)
  expect(result.structured).toEqual(value ?? undefined)
  const parser = createClaudeCodeParser()
  parser.onLine(JSON.stringify({ type: 'result', subtype: 'success', structured_output: value }))
  if (value === null) expect(parser.result()).not.toHaveProperty('structured')
  else expect(parser.result().structured).toEqual(value)
})
it.each([createCodexHarness, createTraeHarness])('%s 使用严格临时文件，解析裸 JSON、清除可选 null，结束后删除', async create => {
  const f = await fake('codex', { ok: true, note: null })
  const harness = create({ bin: f.bin })
  const result = await harness.run({ cwd: f.root, prompt: '任务', resultSchema: schema, sessionId: 'old-session', readOnly: true }, () => {})
  const capture = JSON.parse(await readFile(f.captured, 'utf8')) as { args: string[]; schema: object }
  expect(harness.capabilities?.structuredOutput).toBe(true)
  expect(capture.schema).toMatchObject({ additionalProperties: false, required: ['ok', 'note'], properties: { note: { anyOf: [{ type: 'string' }, { type: 'null' }] } } })
  expect(capture.args.indexOf('--output-schema')).toBeLessThan(capture.args.indexOf('resume'))
  expect(result).toMatchObject({ ok: true, structured: { ok: true } })
  await expect(access(capture.args[capture.args.indexOf('--output-schema') + 1]!)).rejects.toThrow()
})
it('进程失败仍清理 schema 文件，不改变 ok=false', async () => {
  const f = await fake('codex', { ok: true }, 1)
  const result = await createCodexHarness({ bin: f.bin }).run({ cwd: f.root, prompt: '任务', resultSchema: schema }, () => {})
  const { args } = JSON.parse(await readFile(f.captured, 'utf8')) as { args: string[] }
  expect(result.ok).toBe(false)
  await expect(access(args[args.indexOf('--output-schema') + 1]!)).rejects.toThrow()
})
it('自由键 map 降级，保留原 schema 提示且不传 output-schema', async () => {
  const f = await fake('codex', { key: 'value' })
  const events: HarnessEvent[] = []
  const result = await createTraeHarness({ bin: f.bin }).run({ cwd: f.root, prompt: '任务', resultSchema: { type: 'object', additionalProperties: { type: 'string' } } }, event => events.push(event))
  const { args } = JSON.parse(await readFile(f.captured, 'utf8')) as { args: string[] }
  expect(args).not.toContain('--output-schema')
  expect(events.some(event => event.type === 'message' && event.text.includes('严格模式不支持自由键 map'))).toBe(true)
  expect(result).toMatchObject({ ok: true, structured: { key: 'value' } })
})
