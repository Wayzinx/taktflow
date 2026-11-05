import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncSkills } from './skills.js'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
it.each(['claude-code', 'codex', 'opencode', 'pi', 'other'])('syncs %s skills without replacing existing skills', async harness => {
  const root = await mkdtemp(join(tmpdir(), 'takt-skills-')); dirs.push(root)
  const skillsDir = join(root, 'skills'); const targetRoot = join(root, 'target')
  await mkdir(join(skillsDir, 'example'), { recursive: true })
  await writeFile(join(skillsDir, 'example', 'SKILL.md'), 'source')
  const opts = { skillsDir, targetRoot, harness }
  const results = await Promise.all([syncSkills(opts), syncSkills(opts)])
  expect(results.flat()).toHaveLength(1)
  const target = join(targetRoot, harness === 'claude-code' ? '.claude' : '.agents', 'skills/example/SKILL.md')
  expect(await readFile(target, 'utf8')).toBe('source')
  await writeFile(target, 'existing')
  expect(await syncSkills(opts)).toEqual([])
  expect(await readFile(target, 'utf8')).toBe('existing')
  expect(await syncSkills({ ...opts, skillsDir: join(root, 'missing') })).toEqual([])
})
