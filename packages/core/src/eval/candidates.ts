import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EngineDeps } from '../interfaces.js'
import type { EvalVariant } from '../types.js'
import { assertNoSymlinks, fileExists, readJsonFile } from '../store/fs-utils.js'
import { withFileLock } from '../store/file-lock.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { assertArtifactPath } from '../store/paths.js'

interface CandidateManifest { id: string; files: Array<{ path: string; sha256: string }> }
export interface EvalCandidate { id: string; dir: string; variant: EvalVariant }

async function collect(source: string, path: string, files: Map<string, Buffer>): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error('候选包不能包含符号链接；请改用普通文件')
  if (info.isDirectory()) for (const name of (await readdir(source)).sort()) await collect(join(source, name), `${path}/${name}`, files)
  else if (info.isFile()) files.set(path, await readFile(source))
  else throw new Error('候选包只支持普通文件；请移除特殊文件')
}

export async function protectCandidate(dir: string, writable = false): Promise<void> {
  if (writable) await chmod(dir, 0o755)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error('候选包出现符号链接；请检查存储完整性')
    if (entry.isDirectory()) await protectCandidate(path, writable)
    else await chmod(path, writable ? 0o644 : 0o444)
  }
  if (!writable) await chmod(dir, 0o555)
}

export async function verifyCandidate(candidate: EvalCandidate): Promise<void> {
  const manifest = await readJsonFile<CandidateManifest>(join(candidate.dir, 'manifest.json'))
  if (!manifest || manifest.id !== candidate.id || sha256(canonicalJson(manifest.files)) !== candidate.id) throw new Error('候选包清单已改变；请重新启动评测')
  for (const file of manifest.files) {
    assertArtifactPath(file.path)
    const path = join(candidate.dir, file.path)
    await assertNoSymlinks(candidate.dir, path)
    if (sha256(await readFile(path)) !== file.sha256) throw new Error('候选包内容已改变；请重新启动评测')
  }
  const actual = new Map<string, Buffer>()
  await collect(candidate.dir, '', actual)
  if (actual.size !== manifest.files.length + 1) throw new Error('候选包包含未登记文件；请重新启动评测')
}

export async function freezeEvalCandidate(deps: EngineDeps, variant: EvalVariant): Promise<EvalCandidate> {
  const files = new Map<string, Buffer>()
  files.set('profiles.json', Buffer.from(canonicalJson(deps.profiles)))
  files.set('selector.json', Buffer.from(canonicalJson(variant.harness ?? null)))
  const source = variant.skillsDir ?? deps.skillsDir ?? deps.stores.paths.skills
  const projectRoot = await realpath(deps.stores.projectDir), rel = relative(deps.stores.projectDir, source)
  const skills = !rel.startsWith('..') && !isAbsolute(rel) ? join(projectRoot, rel) : source
  await assertNoSymlinks(projectRoot, skills)
  if (await fileExists(skills)) await collect(skills, 'skills', files)
  for (const field of ['promptFile', 'profileFile'] as const) if (variant[field]) await collect(variant[field], field, files)
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, sha256: sha256(content) }))
  const id = sha256(canonicalJson(entries)), root = join(deps.stores.taktDir, 'quality', 'candidates'), dir = join(root, id)
  await assertNoSymlinks(deps.stores.taktDir, dir)
  const candidate: EvalCandidate = { id, dir, variant: { ...variant, skillsDir: join(dir, 'skills'),
    promptFile: variant.promptFile ? join(dir, 'promptFile') : undefined, profileFile: variant.profileFile ? join(dir, 'profileFile') : undefined } }
  await withFileLock(dir, async () => {
    if (await fileExists(dir)) { await verifyCandidate(candidate); return }
    const staging = join(root, `.staging-${randomUUID()}`)
    try {
      await mkdir(join(staging, 'skills'), { recursive: true })
      for (const [path, content] of files) { await mkdir(dirname(join(staging, path)), { recursive: true }); await writeFile(join(staging, path), content) }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify({ id, files: entries }))
      await protectCandidate(staging)
      await rename(staging, dir)
    } catch (error) {
      if (await fileExists(staging)) { await protectCandidate(staging, true); await rm(staging, { recursive: true, force: true }) }
      throw error
    }
  })
  return candidate
}
