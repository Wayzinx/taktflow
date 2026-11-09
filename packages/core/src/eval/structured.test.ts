import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { AgentProfile, HarnessAdapter, HarnessRequest, Invocation } from '../types.js'
import { callReadOnly } from './read-only-call.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('评测和归因共用只读修正：每次身份留痕、逐次事件与总用量', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-output-')); roots.push(root)
  const stores = await initProject(root)
  const calls: HarnessRequest[] = []
  const harness: HarnessAdapter = { id: 'mock', displayName: 'Mock', capabilities: { resume: true }, available: async () => ({ ok: true }), run: async req => {
    calls.push(req)
    return { ok: true, finalText: calls.length === 1 ? '{}' : '{"ok":true}', sessionId: 'same-session', usage: { inputTokens: 1, outputTokens: 2 } }
  } }
  const profile: AgentProfile = { role: 'evaluator', title: '评委', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } }
  const invocations: Invocation[] = []
  const result = await callReadOnly({ stores, profiles: { evaluator: profile }, knowledge: [], harnesses: { mock: harness } }, {
    cwd: root, prompt: '判断', profile, selector: { harness: 'mock' }, role: 'evaluator', recipeKey: 'test', runId: 'eval-structured',
    schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, onInvocation: value => invocations.push(value),
  })
  expect(result.result.structured).toEqual({ ok: true })
  expect(result.result.usage).toEqual({ inputTokens: 2, outputTokens: 4 })
  expect(calls[1]).toMatchObject({ readOnly: true, sessionId: 'same-session' })
  expect(invocations).toHaveLength(2)
  expect(invocations[1]).toMatchObject({ repair: 1, usage: { inputTokens: 1, outputTokens: 2 } })
  expect((await stores.events.read('eval-structured')).map(event => event.type)).toEqual(['output.invalid', 'output.repaired'])
})
