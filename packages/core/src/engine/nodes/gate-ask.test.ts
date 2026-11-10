import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gate } from '../../dsl.js'
import { initProject } from '../../store/project.js'
import type { WorkflowDefinition } from '../../types.js'
import { createEngine } from '../index.js'
import { gateAsk } from './gate.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('门禁裁决的提问写要点：第几次、AC 编号、没过的用例按状态计数，不贴原始 JSON', () => {
  const node = gate({ id: 'delivery-check', title: '交付校验', checks: [{ id: 'acceptance', kind: 'acceptance' }], onFail: 'human' })
  const details = Array.from({ length: 7 }, (_, i) => ({
    ac: `AC-${i + 1}`, title: `标准 ${i + 1}`, pass: i === 6,
    cases: [
      { id: `TC-AC${i + 1}-001`, status: 'passed', pass: true, evidence: [{ workspace: 'REQ-1', path: `evidence/TC-AC${i + 1}-001/log.txt`, version: 3 }] },
      { id: `TC-AC${i + 1}-002`, status: i < 5 ? 'manual_pending' : 'blocked', pass: i === 6, evidence: [] },
    ],
  }))
  const ask = gateAsk(node, [{ id: 'acceptance', pass: false, status: 'fail', message: '交付校验未通过：存在无用例、未通过或缺少证据的 AC', details }], 3)
  expect(ask.split('\n')).toEqual([
    '交付校验第 3 次检查仍未通过：',
    '· acceptance：交付校验未通过：存在无用例、未通过或缺少证据的 AC；未通过的 AC：AC-1、AC-2、AC-3、AC-4、AC-5 等 6 条；没过的用例：manual_pending 5 条、blocked 1 条',
    '通过：放行，继续后面的节点。打回：这一步记为失败，运行结束，之后可以在运行页重试。',
  ])
  expect(ask).not.toContain('evidence/')

  const rubric = gate({ id: 'design-gate', title: '系分门禁', checks: [{ id: 'quality', title: '系分质量', kind: 'rubric', role: 'reviewer', rubric: '评审', threshold: 80 }] })
  expect(gateAsk(rubric, [{ id: 'quality', pass: false, status: 'fail', score: 62, message: 'x'.repeat(500) }]).split('\n')[1]).toBe(`· 系分质量（62 分，需 80）：${'x'.repeat(400)}…`)
})

it('交人裁决的门禁每次失败都只问「通过 / 打回」，打回后重试再失败也不变成「再试一次」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-gate-ask-'))
  roots.push(root)
  const stores = await initProject(root)
  const { id: requirementId } = await stores.workspaces.createRequirement({ title: '门禁裁决' })
  const workflow: WorkflowDefinition = { id: 'gate-ask', title: '门禁裁决', version: '1', stages: [], nodes: [
    gate({ id: 'check', title: '交付校验', onFail: 'human', checks: [{ id: 'always', kind: 'function', fn: async () => ({ id: 'always', pass: false, message: '2 条 AC 未通过' }) }] }),
  ] }
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const by = { type: 'human' as const, id: 'owner' }

  const first = await engine.start({ requirementId, workflow })
  expect(first.status).toBe('waiting_human')
  const [ask1] = await stores.attention.list({ pending: true })
  expect(ask1).toMatchObject({ form: 'approve', ask: '交付校验未通过：\n· always：2 条 AC 未通过\n通过：放行，继续后面的节点。打回：这一步记为失败，运行结束，之后可以在运行页重试。' })

  await stores.attention.answer(ask1!.requestId, { decision: 'reject', by })
  const rejected = await engine.resume(first.runId, workflow)
  expect(rejected.status).toBe('failed')
  expect(rejected.nodes.check?.error).toBe('人工拒绝')

  const retried = await engine.retry(first.runId, workflow, { nodeIds: ['check'] })
  expect(retried.status).toBe('waiting_human')
  const [ask2] = await stores.attention.list({ pending: true })
  expect(ask2).toMatchObject({ form: 'approve' })
  expect(ask2?.kind).toBeUndefined()
  expect(ask2!.ask.split('\n')[0]).toBe('交付校验第 2 次检查仍未通过：')
  expect(await stores.events.read(first.runId, { types: ['retry.suppressed'] })).toEqual([])

  await stores.attention.answer(ask2!.requestId, { decision: 'approve', by })
  expect((await engine.resume(first.runId, workflow)).status).toBe('succeeded')
})
