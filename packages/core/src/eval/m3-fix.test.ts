import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { createEngine } from '../engine/index.js'
import { freezeNode, saveEvalCase } from './cases.js'
import { runEval, waitEvalRun } from './runner.js'
import { createCommandRegistry } from '../commands/index.js'
import { evalCommandSpecs } from '../commands/eval-commands.js'
import type { AgentProfile, EvalCase, HarnessAdapter, HarnessRequest, WorkflowDefinition } from '../types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-fix-eval-')); roots.push(root)
  const stores = await initProject(root)
  const profile: AgentProfile = { role: 'dev', title: '', description: '', instructions: 'role', skills: [], writeScope: ['**'], harness: { harness: 'mock', model: 'tested' } }
  const harness: HarnessAdapter = { id: 'mock', displayName: '', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: 'done' }) }
  const deps = { stores, profiles: { dev: profile, evaluator: { ...profile, role: 'evaluator', harness: { harness: 'mock', model: 'judge' } } }, harnesses: { mock: harness }, knowledge: [] }
  const value: EvalCase = { id: 'case', title: '用例', target: { kind: 'node', workflowId: 'flow', nodeId: 'a' }, source: { kind: 'manual' },
    node: { id: 'a', kind: 'agent', title: '', role: 'dev', needs: [], prompt: 'template' }, prompt: 'template', inputs: [], grading: {}, createdAt: new Date().toISOString() }
  await saveEvalCase(stores, value)
  return { root, stores, deps, value }
}

it('m3-fix 1/26：命令拒绝绝对、穿越及符号链接路径，错误不泄漏路径', async () => {
  const { root, stores, deps, value } = await setup()
  const outside = await mkdtemp(join(tmpdir(), 'takt-private-')); roots.push(outside)
  const privateFile = join(outside, 'private.txt'); await writeFile(privateFile, 'private marker')
  await symlink(outside, join(root, 'linked'), 'dir')
  await mkdir(join(root, 'skills-variant')); await symlink(privateFile, join(root, 'skills-variant/leak'))
  const registry = createCommandRegistry({ stores, extensions: evalCommandSpecs(deps), audit: async () => {} })
  for (const variant of [{ promptFile: privateFile }, { profileFile: privateFile }, { skillsDir: '/' }, { promptFile: '../private.txt' }, { promptFile: 'linked/private.txt' }, { skillsDir: 'skills-variant' }]) {
    const result = await registry.run('eval.run', { target: value.target, variants: [{ id: 'candidate', label: 'bad', ...variant }] }, { actor: { type: 'human', id: 'tester' }, reason: '安全回归' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('变体路径无效')
    expect(result.message).not.toContain(privateFile)
  }
  await expect(readFile(join(stores.taktDir, 'evals/runs'))).rejects.toThrow()
})

it.each(['schema', 'completion', 'pass'])('m3-fix 8/10：冻结原模板、schema 和 completion，回放只组装一次 (%s)', async (mode) => {
  const { stores, deps } = await setup()
  const requirement = await stores.workspaces.createRequirement({ title: '冻结输入' })
  await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'input.txt' }, content: 'UNIQUE_INPUT', kind: 'input', author: { type: 'human', id: 'tester' }, reason: '冻结输入' })
  const criterion = '每条验收标准可验证'
  let replay = false
  const prompts: HarnessRequest[] = []
  deps.harnesses.mock.run = async (request) => {
    if (request.env?.TAKT_ROLE === 'evaluator') return { ok: true, finalText: '', structured: { checks: [{ id: 'c1', criterion: '标准的不同措辞', pass: true, evidence: '输出核对' }], score: 100, reason: '核对通过' } }
    prompts.push(request)
    const checks = [{ id: 'c1', criterion: '标准不同措辞', pass: true, evidence: 'artifact.log' }]
    return { ok: true, finalText: '', structured: { ...(replay && mode === 'schema' ? {} : { valid: true }), ...(replay && mode === 'completion' ? {} : { checks }) } }
  }
  const workflow: WorkflowDefinition = { id: 'flow', title: '', version: '1', stages: [], nodes: [{ kind: 'agent', id: 'a', title: '', role: 'dev', prompt: () => 'RAW_TEMPLATE', inputs: [{ path: 'input.txt' }],
    completion: [criterion], resultSchema: { type: 'object', required: ['valid'], properties: { valid: { type: 'boolean' } } } }] }
  const original = await createEngine(deps).start({ requirementId: requirement.id, workflow })
  expect(original.status).toBe('succeeded')
  const frozen = await freezeNode(stores, original, 'a')
  expect(frozen.prompt).toBe('RAW_TEMPLATE')
  expect(frozen.node).toMatchObject({ resultSchema: { required: ['valid'] }, completion: [criterion], replayPromptKind: 'template' })
  await saveEvalCase(stores, { ...frozen, id: 'case', title: '冻结', source: { kind: 'manual', runId: original.runId, nodeId: 'a' }, target: { kind: 'node', workflowId: 'flow', nodeId: 'a' }, grading: {}, createdAt: new Date().toISOString() })
  replay = true
  const run = await runEval(deps, { target: { kind: 'node', workflowId: 'flow', nodeId: 'a' }, variants: [{ id: 'baseline', label: '基线' }] })
  const result = (await waitEvalRun(stores, run.id)).results[0]!
  expect(prompts[1]?.prompt.match(/UNIQUE_INPUT/g)).toHaveLength(1)
  expect(prompts[1]?.prompt.match(/RAW_TEMPLATE/g)).toHaveLength(1)
  expect(result.pass, result.error).toBe(mode === 'pass')
  if (mode === 'schema') expect(result.error).toContain('valid')
  if (mode === 'completion') expect(result.error).toContain('完成标准未满足')
})
