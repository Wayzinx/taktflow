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

it('refreshes marked skills when any source content changes, removing deleted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-skills-')); dirs.push(root)
  const skillsDir = join(root, 'skills')
  await mkdir(join(skillsDir, 'example', 'scripts'), { recursive: true })
  await writeFile(join(skillsDir, 'example', 'SKILL.md'), 'version-one')
  await writeFile(join(skillsDir, 'example', 'scripts', 'old.ts'), 'old')
  const opts = { skillsDir, targetRoot: join(root, 'target'), harness: 'codex' }
  const [first] = await syncSkills(opts)
  const marker = await readFile(join(first!.target, '.takt-skill'), 'utf8')
  await writeFile(join(skillsDir, 'example', 'SKILL.md'), 'version-two')
  await rm(join(skillsDir, 'example', 'scripts', 'old.ts'))
  await writeFile(join(skillsDir, 'example', 'scripts', 'new.ts'), 'new')
  expect(await syncSkills(opts)).toHaveLength(1)
  expect(await readFile(join(first!.target, 'SKILL.md'), 'utf8')).toBe('version-two')
  expect(await readFile(join(first!.target, 'scripts/new.ts'), 'utf8')).toBe('new')
  await expect(readFile(join(first!.target, 'scripts/old.ts'))).rejects.toThrow()
  expect(await readFile(join(first!.target, '.takt-skill'), 'utf8')).not.toBe(marker)
  expect(await syncSkills(opts)).toEqual([])
  await writeFile(join(skillsDir, 'example', 'scripts/new.ts'), 'newer')
  expect(await syncSkills(opts)).toHaveLength(1)
  expect(await readFile(join(first!.target, 'scripts/new.ts'), 'utf8')).toBe('newer')
})

it('never overwrites user-created skill without a marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-skills-')); dirs.push(root)
  const skillsDir = join(root, 'skills')
  const targetRoot = join(root, 'target')
  const target = join(targetRoot, '.agents/skills/example')
  await mkdir(join(skillsDir, 'example'), { recursive: true })
  await mkdir(target, { recursive: true })
  await writeFile(join(skillsDir, 'example/SKILL.md'), 'source')
  await writeFile(join(target, 'SKILL.md'), 'user-custom')
  const opts = { skillsDir, targetRoot, harness: 'codex' }
  expect(await syncSkills(opts)).toEqual([])
  await writeFile(join(skillsDir, 'example/SKILL.md'), 'changed source')
  expect(await syncSkills(opts)).toEqual([])
  expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('user-custom')
})
