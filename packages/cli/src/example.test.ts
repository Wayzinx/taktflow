import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { NodeContext } from '@taktflow/core'
import workflow from '../../../examples/hello-delivery/.takt/workflows/sdlc.workflow.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const loop = workflow.nodes.find((node) => node.id === 'dev-test-loop')!
if (loop.kind !== 'loop') throw new Error('缺少示例 loop')
const body = loop.body

it('修复 prompt 只注入本目标路由对象与判决，并声明证据输入', async () => {
  const verdicts = [
    { subject: 'TC-CODE', category: 'product_bug', rationale: '空名字错误', evidence: ['evidence/TC-CODE/result.json'] },
    { subject: 'TC-SCRIPT', category: 'script_defect', rationale: '取值错误', evidence: ['evidence/TC-SCRIPT/result.json'] },
    { subject: 'TC-CASE', category: 'case_defect', rationale: '预期不符契约', evidence: ['evidence/TC-CASE/result.json'] },
  ]
  const routed = { 'fix-code': ['TC-CODE'], 'fix-script': ['TC-SCRIPT'], 'fix-case': ['TC-CASE'] }
  const context = { resultOf: (id: string) => { expect(id).toBe('judge'); return { verdicts, routed } } } as NodeContext
  for (const [target, subjects] of Object.entries(routed)) {
    const node = body.find((node) => node.id === target)!
    if (node.kind !== 'agent' || typeof node.prompt !== 'function') throw new Error('修复节点必须使用动态 prompt')
    const prompt = await node.prompt(context)
    expect(prompt).toContain(subjects[0])
    expect(prompt).toContain(`evidence/${subjects[0]}/result.json`)
    for (const verdict of verdicts.filter((verdict) => !subjects.includes(verdict.subject))) expect(prompt).not.toContain(verdict.subject)
    expect(node.inputs).toEqual(expect.arrayContaining([{ path: 'reports/verdicts/**', required: false }, { path: 'evidence/**', required: false }]))
  }
  const runner = body.find((node) => node.id === 'run-cases')!
  expect(runner.outputs).toContainEqual({ path: 'evidence/**', kind: 'evidence' })
  expect(runner.outputs).toContainEqual({ path: 'evidence/summary.json', kind: 'evidence' })
})

it('用例子进程等待期间事件循环继续执行；缺新 summary 时不会复用旧 PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-example-async-'))
  roots.push(root)
  await mkdir(join(root, 'evidence'))
  await writeFile(join(root, 'delayed.mjs'), `import { writeFile } from 'node:fs/promises'; await new Promise(resolve => setTimeout(resolve, 150)); await writeFile(process.env.TAKT_WORKSPACE + '/evidence/summary.json', JSON.stringify({cases:[{id:'TC-1',status:'passed'}]}));`)
  const node = body.find((node) => node.id === 'run-cases')!
  if (node.kind !== 'script' || typeof node.run !== 'function') throw new Error('缺少用例脚本')
  const context: NodeContext = {
    runId: 'run-1', requirementId: 'REQ-1', nodeId: 'dev-test-loop/run-cases', projectDir: root, workspaceDir: root,
    args: { caseCommand: 'node delayed.mjs' }, resultOf: () => undefined, log: () => {},
    readArtifact: async (path) => { try { return await readFile(join(root, path), 'utf8') } catch { return undefined } },
  }
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  try { expect(await node.run(context)).toMatchObject({ data: { total: 1, failures: [] } }) } finally { clearInterval(timer) }
  expect(ticks).toBeGreaterThan(2)
  expect(await node.run({ ...context, args: { caseCommand: 'exit 1' } })).toMatchObject({ status: 'blocked' })
})
