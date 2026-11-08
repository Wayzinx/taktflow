import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { AgentProfile, EvalCase, HarnessAdapter } from '../types.js'
import { listEvalCases } from './cases.js'
import { runEval, waitEvalRun } from './runner.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('M5：技能自带的旧写节点用例仍可读，但不执行整节点回放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-variants-')); roots.push(root)
  const stores = await initProject(root)
  const builtin = join(stores.paths.skills, 'work', 'evals'), replacement = join(root, 'replacement')
  await mkdir(builtin, { recursive: true }); await mkdir(join(replacement, 'work'), { recursive: true })
  await writeFile(join(stores.paths.skills, 'work/SKILL.md'), 'baseline skill')
  await writeFile(join(replacement, 'work/SKILL.md'), 'frozen skill')
  const promptFile = join(root, 'prompt.txt'), profileFile = join(root, 'profile.md')
  await writeFile(promptFile, 'frozen prompt')
  await writeFile(profileFile, '---\nrole: dev\nharness: { harness: mock, model: changed }\nwriteScope: ["**"]\n---\nfrozen profile')
  for (let index = 1; index <= 3; index++) {
    const value: EvalCase = { id: `skill-${index}`, title: '技能用例', target: { kind: 'skill', name: 'work' }, source: { kind: 'skill' },
      node: { id: 'dev', kind: 'agent', title: '实现', role: 'dev', needs: [], outputs: [{ path: 'result.json', kind: 'other', schema: { type: 'object', required: ['valid'], properties: { valid: { type: 'boolean' } } } }] },
      prompt: 'baseline prompt', inputs: [{ path: 'input.txt', content: 'frozen input' }], grading: { commands: ['test -f result.json'] }, createdAt: new Date().toISOString() }
    await writeFile(join(builtin, `${value.id}.json`), JSON.stringify(value))
  }
  const profile: AgentProfile = { role: 'dev', title: 'dev', description: '', instructions: 'baseline profile', harness: { harness: 'mock', model: 'baseline' }, skills: ['work'], writeScope: ['**'] }
  const models: string[] = []
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), async run(request) {
    const changed = request.model === 'changed'; models.push(request.model!)
    expect(await readFile(join(request.env!.TAKT_WORKSPACE!, 'input.txt'), 'utf8')).toBe('frozen input')
    if (changed) {
      expect(request.prompt).toContain('frozen prompt')
      expect(request.systemAppend).toBe('frozen profile')
      expect(await readFile(join(request.cwd, '.agents/skills/work/SKILL.md'), 'utf8')).toBe('frozen skill')
    }
    const output = join(request.env!.TAKT_WORKSPACE!, 'result.json')
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, changed ? '{"valid":true}' : '{"wrong":true}')
    return { ok: true, finalText: 'done' }
  } }
  expect(await listEvalCases(stores, { kind: 'skill', name: 'work' })).toHaveLength(3)
  const run = await runEval({ stores, profiles: { dev: profile }, harnesses: { mock: harness }, knowledge: [], skillsDir: stores.paths.skills }, {
    target: { kind: 'skill', name: 'work' }, variants: [{ id: 'candidate', label: '冻结变体', promptFile: 'prompt.txt', profileFile: 'profile.md', skillsDir: 'replacement' }],
  })
  await writeFile(promptFile, 'changed after start')
  await writeFile(join(replacement, 'work/SKILL.md'), 'changed after start')
  const result = await waitEvalRun(stores, run.id)
  expect(result).toMatchObject({ status: 'refused', results: [] })
  expect(models).toEqual([])
  expect(result.isolation?.reasons?.join('')).toContain('整节点')
})
