import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessResult, Usage } from '@taktflow/core'
import type { EventSink, StreamParser } from '../parse.js'
import { finalizeResult } from '../process.js'

export type ConformanceParse<Input = string> = (
  input: Input, onEvent: EventSink, request: HarnessRequest,
) => HarnessResult | Promise<HarnessResult>

export interface FixtureSource {
  kind: 'synthetic' | 'recording'
  /** synthetic 写明依据；recording 写明实录来源，不能将手写样例标成实录。 */
  description: string
}

export interface ConformanceFixture<Input = string> {
  name: string
  source: FixtureSource
  input: Input
  request?: Partial<HarnessRequest>
}

export interface SuccessFixture<Input = string> extends ConformanceFixture<Input> {
  expected: {
    started: Extract<HarnessEvent, { type: 'started' }>
    message: Extract<HarnessEvent, { type: 'message' }>
    toolCall: Extract<HarnessEvent, { type: 'tool_call' }>
    usage?: Usage
    /** 多轮流的 usage 事件可以是增量；结果中的 usage 仍断言总量。 */
    usageEvents?: readonly Usage[]
    finalText: string
    sessionId?: string
  }
}

export interface StructuredFixture<Input = string> extends ConformanceFixture<Input> {
  schema: Record<string, unknown>
  expected: unknown
}

export interface ErrorFixture<Input = string> extends ConformanceFixture<Input> {
  keywords: readonly string[]
}

export interface ConformanceFixtures<Input = string> {
  success: SuccessFixture<Input>
  structured: StructuredFixture<Input>
  errors: readonly ErrorFixture<Input>[]
}

export interface ConformanceRuntime {
  /** bin 是测试创建的本地可执行文件，工厂必须实际使用它。 */
  create: (bin: string) => HarnessAdapter
  timeoutMs?: number
  /** 可选的真实 adapter.run 回放；不提供时仍执行进程超时、取消测试。 */
  replay?: ConformanceFixtures<string>
}

export interface HarnessConformanceOptions<Input = string> {
  parse: ConformanceParse<Input>
  fixtures: ConformanceFixtures<Input>
  runtime?: ConformanceRuntime
  /** 进程内适配器可通过此入口验证取消，无需伪造 CLI。 */
  cancellation?: () => HarnessAdapter
  /** 等待模型回包的进程内适配器，可检查其自身的超时边界。 */
  timeout?: () => HarnessAdapter
}

export function parseHarnessStream(createParser: (onEvent: EventSink) => StreamParser): ConformanceParse {
  return (input, onEvent, req) => {
    const parser = createParser(onEvent)
    input.split(/\r?\n/).forEach(line => parser.onLine(line))
    return finalizeResult(req, parser.result(), { ok: true, stdout: input, stderr: '', exitCode: 0 })
  }
}

function request(dir: string, fixture?: ConformanceFixture<unknown>): HarnessRequest {
  return { prompt: 'offline harness conformance', ...fixture?.request, cwd: dir }
}

async function inTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'takt-conformance-'))
  try { return await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

function fixtureLabel(fixture: ConformanceFixture<unknown>): string {
  return `${fixture.name} [${fixture.source.kind}: ${fixture.source.description}]`
}

function assertSuccess(result: HarnessResult, events: HarnessEvent[], fixture: SuccessFixture<unknown>): void {
  expect(result.ok).toBe(true)
  expect(result.error).toBeUndefined()
  expect(result.finalText).toBe(fixture.expected.finalText)
  if (fixture.expected.sessionId !== undefined) expect(result.sessionId).toBe(fixture.expected.sessionId)
  expect(result.usage).toEqual(fixture.expected.usage)
  for (const expected of [fixture.expected.started, fixture.expected.message, fixture.expected.toolCall,
    ...(fixture.expected.usageEvents ?? (fixture.expected.usage ? [fixture.expected.usage] : [])).map(usage => ({ type: 'usage', usage }))]) {
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining(expected)]))
  }
}

function assertError(result: HarnessResult, fixture: ErrorFixture<unknown>): void {
  expect(fixture.keywords.length, '错误样例必须声明需要保留的分类关键词').toBeGreaterThan(0)
  expect(result.ok).toBe(false)
  for (const keyword of fixture.keywords) expect(result.error).toContain(keyword)
}

async function executable(dir: string, output?: string): Promise<string> {
  const bin = join(dir, 'fixture-cli')
  // 不解释 CLI 参数，确保测试覆盖 adapter 的启动/收尾而不依赖外部模型或登录。
  const readyPath = `'${join(dir, 'ready').replaceAll("'", "'\\''")}'`
  const script = output === undefined
    ? `#!/bin/sh\nprintf '%s' "$$" > ${readyPath}\nwhile :; do sleep 1; done\n`
    : `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output.endsWith('\n') ? output : `${output}\n`)});\n`
  await writeFile(bin, script, { mode: 0o700 })
  return bin
}

async function ready(dir: string): Promise<number> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(join(dir, 'ready'), 'utf8'))
      // 文件创建与写入不是原子操作；空内容或尚未写完整的 PID 不能作为启动证据。
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(10)
  }
  throw new Error('注入的本地 CLI 未启动，不能将启动失败算作取消通过')
}

function assertStopped(pid: number): void {
  expect(pid).toBeGreaterThan(0)
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
}

export function runHarnessConformance<Input = string>(name: string, options: HarnessConformanceOptions<Input>): void {
  const { parse, fixtures, runtime } = options
  describe(`${name} harness conformance`, () => {
    it(`事件及最终文本: ${fixtureLabel(fixtures.success)}`, () => inTemp(async dir => {
      const events: HarnessEvent[] = []
      const result = await parse(fixtures.success.input, event => events.push(event), request(dir, fixtures.success))
      assertSuccess(result, events, fixtures.success)
    }))

    it(`schema JSON 提取: ${fixtureLabel(fixtures.structured)}`, () => inTemp(async dir => {
      const fixture = fixtures.structured
      const result = await parse(fixture.input, () => {}, { ...request(dir, fixture), resultSchema: fixture.schema })
      expect(result.ok).toBe(true)
      expect(result.structured).toEqual(fixture.expected)
      const withoutSchema = await parse(fixture.input, () => {}, { ...request(dir, fixture), resultSchema: undefined })
      expect(withoutSchema.structured).toBeUndefined()
    }))

    for (const fixture of fixtures.errors) {
      it(`错误保真: ${fixtureLabel(fixture)}`, () => inTemp(async dir => {
        assertError(await parse(fixture.input, () => {}, request(dir, fixture)), fixture)
      }))
    }

    if (options.cancellation) {
      it('进程内适配器响应 AbortSignal', () => inTemp(async dir => {
        const harness = options.cancellation!()
        const controller = new AbortController()
        const result = await harness.run({ ...request(dir), signal: controller.signal }, event => {
          if (event.type === 'started') controller.abort()
        })
        expect(controller.signal.aborted).toBe(true)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/cancel|abort/i)
      }))
    }

    if (options.timeout) {
      it('进程内适配器超时结束', () => inTemp(async dir => {
        const result = await options.timeout!().run({ ...request(dir), timeoutMs: 50 }, () => {})
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/timeout|timed out/i)
      }))
    }

    if (runtime) {
      it('本地子进程超时并回收', () => inTemp(async dir => {
        const harness = runtime.create(await executable(dir))
        const controller = new AbortController()
        const timeoutMs = runtime.timeoutMs ?? 30_000
        let pending: Promise<HarnessResult> | undefined
        // 只冻结进程超时/升级终止的定时器；Date 和 timers/promises 的启动握手仍走真实时间。
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          pending = harness.run({ ...request(dir), timeoutMs, signal: controller.signal }, () => {})
          const pid = await ready(dir)
          await vi.advanceTimersByTimeAsync(timeoutMs)
          await vi.runOnlyPendingTimersAsync()
          const result = await pending
          expect(result.ok).toBe(false)
          expect(result.error).toMatch(/timeout/i)
          assertStopped(pid)
        } finally {
          controller.abort()
          try {
            await vi.runAllTimersAsync()
          } finally {
            try { await pending } finally { vi.useRealTimers() }
          }
        }
      }), 20_000)

      it('启动后取消本地子进程并回收', () => inTemp(async dir => {
        const controller = new AbortController()
        const harness = runtime.create(await executable(dir))
        const pending = harness.run({ ...request(dir), timeoutMs: 20_000, signal: controller.signal }, () => {})
        try {
          const pid = await ready(dir)
          controller.abort()
          const result = await pending
          expect(result.ok).toBe(false)
          expect(result.error).toMatch(/cancel|abort/i)
          expect(result.error).not.toMatch(/timeout/i)
          assertStopped(pid)
        } finally {
          controller.abort()
          await pending
        }
      }), 30_000)

      const replay = runtime.replay
      if (replay) {
        it(`本地 CLI 事件回放: ${fixtureLabel(replay.success)}`, () => inTemp(async dir => {
          const harness = runtime.create(await executable(dir, replay.success.input))
          const events: HarnessEvent[] = []
          const result = await harness.run({ ...request(dir, replay.success), timeoutMs: 10_000 }, event => events.push(event))
          assertSuccess(result, events, replay.success)
        }), 15_000)
        it(`本地 CLI schema 提取: ${fixtureLabel(replay.structured)}`, () => inTemp(async dir => {
          const harness = runtime.create(await executable(dir, replay.structured.input))
          const result = await harness.run({ ...request(dir, replay.structured), timeoutMs: 10_000,
            resultSchema: replay.structured.schema }, () => {})
          expect(result.ok).toBe(true)
          expect(result.structured).toEqual(replay.structured.expected)
        }), 15_000)
        for (const fixture of replay.errors) {
          it(`本地 CLI 错误保真: ${fixtureLabel(fixture)}`, () => inTemp(async dir => {
            const harness = runtime.create(await executable(dir, fixture.input))
            assertError(await harness.run({ ...request(dir, fixture), timeoutMs: 10_000 }, () => {}), fixture)
          }), 15_000)
        }
      }
    }
  })
}
