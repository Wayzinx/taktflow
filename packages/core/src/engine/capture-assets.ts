import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { AgentProfile } from '../types.js'
import type { AssetRef } from '../quality.js'
import type { HarnessHost } from './harness.js'
import type { CapturedAsset, CaptureContext } from './capture-types.js'
import { assertNoSymlinks, isEnoent } from '../store/fs-utils.js'
import { canonicalJson, sha256 } from '../util/hash.js'

export function inlineAsset(id: string, content: string): CapturedAsset {
  return { kind: 'inline', id, sha256: sha256(content), content }
}
export function assetRef({ content: _content, ...ref }: CapturedAsset): AssetRef { return ref }

async function directoryAsset(root: string, id: string): Promise<CapturedAsset | undefined> {
  const files: Array<{ path: string; sha256: string; content: string }> = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`技能目录不允许符号链接：${id}/${relative(root, file)}`)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) {
        const bytes = await readFile(file)
        files.push({ path: relative(root, file), sha256: sha256(bytes), content: bytes.toString('utf8') })
      }
    }
  }
  try { await assertNoSymlinks(root, root); await walk(root) } catch (error) { if (isEnoent(error)) return undefined; throw error }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { kind: 'file', id, sha256: sha256(canonicalJson(files.map(({ path, sha256 }) => ({ path, sha256 })))), content: canonicalJson({ files }) }
}

export async function captureAssets(host: HarnessHost, profile: AgentProfile, cwd: string, harness: string, context: CaptureContext, template: string, staticPrompt: string) {
  const stores = host.deps.stores
  let role = host.capture?.profiles?.[profile.role]
  const notes: string[] = []
  if (role && sha256(role.content) !== role.sha256) throw new Error(`角色资产 hash 不匹配：${role.id}`)
  role ??= inlineAsset(`role:${profile.role}`, canonicalJson(profile))
  const declared: CapturedAsset[] = []
  const source = host.deps.skillsDir ?? stores.paths.skills
  for (const name of [...profile.skills].sort()) {
    const dir = resolve(source, name)
    if (relative(source, dir).startsWith('..')) throw new Error(`技能路径越界：${name}`)
    const skill = await directoryAsset(dir, relative(stores.projectDir, dir))
    if (skill) declared.push(skill)
    else { declared.push(inlineAsset(`missing-skill:${name}`, '')); notes.push(`声明的 Skill 缺失：${name}`) }
  }
  const target = join(cwd, harness === 'claude-code' ? '.claude' : '.agents', 'skills')
  const provided: CapturedAsset[] = []
  let entries
  try { await assertNoSymlinks(cwd, target); entries = await readdir(target, { withFileTypes: true }) } catch (error) { if (!isEnoent(error)) throw error }
  for (const entry of (entries ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`技能目录不允许符号链接：${entry.name}`)
    if (!entry.isDirectory()) continue
    const skill = await directoryAsset(join(target, entry.name), `${harness === 'claude-code' ? '.claude' : '.agents'}/skills/${entry.name}`)
    if (skill) provided.push(skill)
  }
  return { role, declared, provided, template: context.render?.duty ?? inlineAsset(`prompt:${context.render?.kind ?? 'node-prompt'}`, canonicalJson({ template, definition: context.render?.staticPrompt ?? staticPrompt })), duty: context.render?.duty, notes }
}
