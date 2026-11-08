import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createEngine } from './index.js'
import { initProject, resolvePaths } from '../store/project.js'
import { loadedSkills, recipeKey, recipeOf, skillContentHash } from './recipe.js'
import type { AgentProfile, HarnessAdapter } from '../types.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('实际技能内容改变改变 recipeKey，经验变化不改变，动态 prompt 取函数源码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-recipe-')); roots.push(root)
  const stores = await initProject(root), req = await stores.workspaces.createRequirement({ title: 'recipe' })
  const profile: AgentProfile = { role: 'dev', title: 'dev', description: '', instructions: 'dev', harness: { harness: 'mock', model: 'one' }, skills: ['skill'], writeScope: ['**'] }
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: 'done' }) }
  await mkdir(join(stores.paths.skills, 'skill'), { recursive: true })
  await writeFile(join(stores.paths.skills, 'skill', 'SKILL.md'), 'v1')
  const prompt = () => '动态 prompt'
  const deps = { stores, profiles: { dev: profile }, harnesses: { mock: harness }, knowledge: [], skillsDir: stores.paths.skills }
  const workflow = { id: 'recipe', title: 'recipe', version: '1', stages: [], nodes: [{ id: 'node', kind: 'agent' as const, role: 'dev', title: 'node', prompt }] }
  const first = await createEngine(deps).start({ workflow, requirementId: req.id })
  expect(first.status).toBe('succeeded')
  const events = await stores.events.read(first.runId)
  expect(events.filter((e) => e.type === 'node.recipe')).toHaveLength(1)
  expect(events.some((e) => e.type === 'log' && JSON.stringify(e.data).includes('node.recipe.inputs'))).toBe(false)
  const a = recipeOf(events, 'node')!
  expect(a.inputs).toEqual([])
  expect(a.skills).toHaveLength(1)
  const { recipeKey: _key, ...identity } = a
  expect(recipeKey({ ...identity, lessons: ['L-1'] })).toBe(recipeKey({ ...identity, lessons: ['L-2'] }))
  expect(recipeKey({ ...identity, inputs: [{ workspace: req.id, path: 'input.md', version: 1 }] })).toBe(recipeKey({ ...identity, inputs: [{ workspace: req.id, path: 'input.md', version: 2 }] }))
  await writeFile(join(stores.paths.skills, 'skill', 'SKILL.md'), 'v2')
  const second = await createEngine(deps).start({ workflow, requirementId: req.id })
  expect(second.status).toBe('succeeded')
  const b = recipeOf(await stores.events.read(second.runId), 'node')!
  expect(a.recipeKey).not.toBe(b.recipeKey)
  expect(a.promptHash).toBe(b.promptHash)
  expect(await loadedSkills(root, 'mock')).toEqual([{ name: 'skill', hash: await skillContentHash(join(root, '.agents/skills/skill')) }])
  expect((await resolvePaths(root, stores.config)).evals).toBe(join(root, 'evals'))
  const legacy = await mkdtemp(join(tmpdir(), 'takt-eval-legacy-')); roots.push(legacy)
  expect((await initProject(legacy, { layout: 'legacy' })).paths.evals).toBe(join(legacy, '.takt/evals'))
})

it('m3-fix 7/23：fallback 配方记录实际后继 harness 与模型，读取取最后一条', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-recipe-fallback-')); roots.push(root)
  const stores = await initProject(root), req = await stores.workspaces.createRequirement({ title: 'fallback' })
  const adapter = (id: string, ok: boolean): HarnessAdapter => ({ id, displayName: id, available: async () => ({ ok: true }), run: async () => ({ ok, error: ok ? undefined : '429', finalText: 'done' }) })
  const profile: AgentProfile = { role: 'dev', title: '', description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'first', model: 'one', fallback: [{ harness: 'second', model: 'two' }] } }
  const state = await createEngine({ stores, profiles: { dev: profile }, harnesses: { first: adapter('first', false), second: adapter('second', true) }, knowledge: [] }).start({ requirementId: req.id,
    workflow: { id: 'fallback', title: '', version: '1', stages: [], nodes: [{ id: 'a', kind: 'agent', title: '', role: 'dev', prompt: 'implement' }] } })
  expect(state.status).toBe('succeeded')
  const events = await stores.events.read(state.runId)
  expect(events.filter((event) => event.type === 'node.recipe')).toHaveLength(2)
  expect(recipeOf(events, 'a')).toMatchObject({ harness: 'second', model: 'two' })
  const { scorecards } = await import('../eval/scorecards.js')
  const cards = await scorecards(stores, { by: 'recipe' })
  // doc 21 §2：每个 fallback 候选是一条真实调用，配方成绩不能丢掉失败的首选。
  const starts = events.filter(event => event.type === 'invocation.started').map(event => event.data as import('../types.js').InvocationStart)
  expect(starts.map(value => [value.harness, value.attempt, value.fallbackIndex])).toEqual([['first', 1, 0], ['second', 1, 1]])
  expect(cards).toHaveLength(2)
  expect(cards.map(card => card.key.recipeKey).sort()).toEqual(starts.map(value => value.recipeKey).sort())
  expect(await scorecards(stores, { by: 'node' })).toHaveLength(1)
})
