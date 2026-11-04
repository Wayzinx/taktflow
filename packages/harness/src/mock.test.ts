import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessEvent, HarnessRequest } from '@taktflow/core'
import { createMockHarness, loadMockScript } from './mock.js'
import type { MockScript } from './mock.js'

let dir: string
function request(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return { cwd: dir, prompt: 'implement feature', env: { TAKT_ROLE: 'dev', TAKT_NODE: 'build', TAKT_WORKSPACE: join(dir, 'workspace') }, ...overrides }
}
const ignore = () => {}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'takt-mock-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('createMockHarness', () => {
  it('公开适配器信息且始终可用', async () => {
    const harness = createMockHarness({ steps: [] })
    expect(harness.id).toBe('mock')
    expect(harness.displayName).toBeTruthy()
    expect(await harness.available()).toEqual({ ok: true })
  })

  it('按顺序匹配 role/node/promptIncludes，默认不限次数', async () => {
    const harness = createMockHarness({ steps: [
      { match: { role: 'qa' }, finalText: 'wrong role' },
      { match: { nodeId: 'review' }, finalText: 'wrong node' },
      { match: { promptIncludes: 'absent' }, finalText: 'wrong prompt' },
      { match: { role: 'dev', nodeId: 'build', promptIncludes: 'feature' }, finalText: 'first' },
      { finalText: 'fallback' },
    ] })
    for (let i = 0; i < 3; i++) expect((await harness.run(request(), ignore)).finalText).toBe('first')
    expect((await harness.run(request({ env: {} }), ignore)).finalText).toBe('fallback')
  })

  it('未匹配返回规定结果，无 match 则任意匹配', async () => {
    const harness = createMockHarness({ steps: [{ match: { role: 'qa' } }] })
    expect(await harness.run(request(), ignore)).toMatchObject({ ok: true, finalText: '(mock) no step matched' })
    expect(await harness.run(request({ resultSchema: {} }), ignore)).toMatchObject({ ok: true, finalText: '(mock) no step matched', structured: undefined })
    expect(await createMockHarness({ steps: [{}] }).run(request(), ignore)).toMatchObject({ ok: true, finalText: '' })
  })

  it('times=0 跳过，有限次数在 await 前被并发调用原子消耗', async () => {
    const script: MockScript = { steps: [
      { times: 0, finalText: 'disabled' },
      { times: 1, writes: { 'nested/first.txt': 'first' }, finalText: 'once' },
      { times: 2, finalText: 'twice' },
      { finalText: 'unlimited' },
    ] }
    const harness = createMockHarness(script)
    const results = await Promise.all(Array.from({ length: 6 }, () => harness.run(request(), ignore)))
    expect(results.map(result => result.finalText)).toEqual(['once', 'twice', 'twice', 'unlimited', 'unlimited', 'unlimited'])
    expect(await readFile(join(dir, 'nested/first.txt'), 'utf8')).toBe('first')
    expect((await createMockHarness(script).run(request(), ignore)).finalText).toBe('once')
    expect(script.steps[1]!.times).toBe(1)
  })

  it('相对 cwd 与 workspace 写文件并创建父目录', async () => {
    const harness = createMockHarness({ steps: [{ writes: { 'src/file.txt': 'local', '{{workspace}}/spec/a.md': '文档' } }] })
    expect((await harness.run(request(), ignore)).ok).toBe(true)
    expect(await readFile(join(dir, 'src/file.txt'), 'utf8')).toBe('local')
    expect(await readFile(join(dir, 'workspace/spec/a.md'), 'utf8')).toBe('文档')
  })

  it('workspace 未配置或写盘错误返回失败', async () => {
    const harness = createMockHarness({ steps: [{ writes: { '{{workspace}}/x': 'data' } }] })
    expect(await harness.run(request({ env: {} }), ignore)).toMatchObject({ ok: false, error: expect.stringContaining('TAKT_WORKSPACE') })
    await writeFile(join(dir, 'file'), 'content')
    expect(await createMockHarness({ steps: [{ writes: { 'file/x': 'data' } }] }).run(request(), ignore)).toMatchObject({ ok: false, error: expect.stringContaining('Mock failed') })
  })

  it('发送 started、tools、usage、compacted 和最终 message，record 符合协议', async () => {
    const usage = { inputTokens: 20, outputTokens: 5, cachedTokens: 3, costUsd: 0.1 }
    const compaction = { beforeTokens: 100, afterTokens: 10, summary: 'summary', dropped: ['old messages'] }
    const toolCalls = [{ tool: 'read', input: 'a', output: 'text' }, { tool: 'write', input: 'b' }]
    const events: HarnessEvent[] = []
    const harness = createMockHarness({ steps: [{ finalText: 'done', usage, compaction, toolCalls }] })
    expect(await harness.run(request({ sessionId: 'session', model: 'model' }), event => events.push(event))).toMatchObject({ ok: true, finalText: 'done', usage })
    expect(events).toEqual([
      { type: 'started', sessionId: 'session', model: 'model' },
      ...toolCalls.map(call => ({ type: 'tool_call', ...call })),
      { type: 'usage', usage },
      { type: 'compacted', record: { ...compaction, at: expect.any(String), trigger: 'auto' } },
      { type: 'message', role: 'assistant', text: 'done' },
    ])
    const event = events[4]!
    if (event.type !== 'compacted') throw new Error('Expected compaction event')
    expect(new Date(event.record.at).toISOString()).toBe(event.record.at)
    expect(event.record).not.toHaveProperty('nodeId')
  })

  it.each([null, false, 0, [], { result: true }])('structured %j 拼到最后块，schema 存在时才提取', async structured => {
    const harness = createMockHarness({ steps: [{ finalText: 'before\n```json\n{"old":true}\n```', structured }] })
    const without = await harness.run(request(), ignore)
    expect(without).not.toHaveProperty('structured')
    expect(without.finalText).toContain(`\`\`\`json\n${JSON.stringify(structured)}\n\`\`\``)
    expect(await harness.run(request({ resultSchema: {} }), ignore)).toMatchObject({ ok: true, structured })
  })

  it('没有显式 structured 时也提取最后文本块；末块损坏不回退', async () => {
    const harness = createMockHarness({ steps: [
      { times: 1, finalText: '```json\n{"value":1}\n```' },
      { finalText: '```json\n{"old":true}\n```\n```json\nbad\n```' },
    ] })
    expect(await harness.run(request({ resultSchema: {} }), ignore)).toMatchObject({ ok: true, structured: { value: 1 } })
    expect(await harness.run(request({ resultSchema: {} }), ignore)).toMatchObject({ ok: true, structured: undefined })
  })

  it('fail 保留错误、输出和 usage，失败步骤同样消耗 times', async () => {
    const harness = createMockHarness({ steps: [{ times: 1, fail: 'HTTP 429', finalText: 'partial', usage: { inputTokens: 1, outputTokens: 2 } }] })
    expect(await harness.run(request(), ignore)).toMatchObject({ ok: false, error: 'HTTP 429', finalText: 'partial', usage: { inputTokens: 1, outputTokens: 2 } })
    expect(await harness.run(request(), ignore)).toMatchObject({ ok: true, finalText: '(mock) no step matched' })
  })

  it('空 fail 也代表失败，schema 提取失败不改变 fail', async () => {
    expect((await createMockHarness({ steps: [{ fail: '' }] }).run(request(), ignore)).ok).toBe(false)
    const result = await createMockHarness({ steps: [{ fail: 'overloaded' }] }).run(request({ resultSchema: {} }), ignore)
    expect(result).toMatchObject({ ok: false, error: 'overloaded', structured: undefined })
  })

  it('事件回调抛错和 structured 无法序列化以失败返回', async () => {
    expect(await createMockHarness({ steps: [{}] }).run(request(), () => { throw new Error('event error') })).toMatchObject({ ok: false, error: expect.stringContaining('event error') })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(await createMockHarness({ steps: [{ structured: circular }] }).run(request(), ignore)).toMatchObject({ ok: false, error: expect.stringContaining('circular') })
  })

  it('预取消不消费步骤、不写盘', async () => {
    const controller = new AbortController()
    controller.abort()
    const harness = createMockHarness({ steps: [{ times: 1, writes: { 'marker': 'yes' }, finalText: 'once' }] })
    expect(await harness.run(request({ signal: controller.signal }), ignore)).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
    await expect(readFile(join(dir, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await harness.run(request(), ignore)).finalText).toBe('once')
  })
})

describe('loadMockScript', () => {
  it('异步读取 JSON 并可直接执行', async () => {
    const path = join(dir, 'script.json')
    const script: MockScript = { steps: [{ finalText: 'loaded', times: 1 }] }
    await writeFile(path, JSON.stringify(script))
    const loaded = loadMockScript(path)
    expect(loaded).toBeInstanceOf(Promise)
    expect(await loaded).toEqual(script)
    expect((await createMockHarness(await loaded).run(request(), ignore)).finalText).toBe('loaded')
  })
  it('缺失文件或损坏 JSON 传递读取/解析错误', async () => {
    await expect(loadMockScript(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    const path = join(dir, 'bad.json')
    await writeFile(path, '{broken')
    await expect(loadMockScript(path)).rejects.toBeInstanceOf(SyntaxError)
  })
})
