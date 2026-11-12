import { randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter, systemWrite, type ProjectStores, type SkillFileContent, type SkillImportResult, type SkillImportSource, type SkillTree } from '@taktflow/core'
import { actor, authorize, body, HttpError, text } from './http.js'
import { atomicWrite, auditSpace } from './space.js'
import { SKILL_LIMITS, SKIP_NAMES, finishImport, isText, previewImport, skillName, skillPath, stagedImport, walkFiles, withSkillName } from './skill-import.js'
import { STREAMING, type Handler } from './routes.js'

const posix = (from: string, to: string) => relative(from, to).split(sep).join('/')
const exists = (path: string) => lstat(path).then(() => true, () => false)
const isDir = (path: string) => lstat(path).then((s) => s.isDirectory(), () => false)
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

/** 逐段拒绝符号链接，防止在线编辑或导入逃出技能目录。 */
async function noLinks(stores: ProjectStores, full: string): Promise<void> {
  const project = resolve(stores.projectDir)
  const boundary = relative(project, full).startsWith('..') ? dirname(resolve(stores.paths.skills)) : project
  for (let current = resolve(full); current !== boundary && dirname(current) !== current; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new HttpError(400, '技能路径不能包含符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

async function skillDir(stores: ProjectStores, name: unknown): Promise<{ name: string; dir: string }> {
  const key = skillName(name)
  const dir = join(stores.paths.skills, key)
  await noLinks(stores, dir)
  return { name: key, dir }
}

async function skillFile(stores: ProjectStores, name: unknown, path: unknown) {
  const skill = await skillDir(stores, name)
  const rel = skillPath(path)
  const file = join(skill.dir, rel)
  await noLinks(stores, file)
  return { ...skill, path: rel, file }
}

/** 技能目录整体受控写入：同步副本、配方哈希都按整个文件夹算。 */
function writeSkills<T>(stores: ProjectStores, names: string[], fn: () => Promise<T>): Promise<T> {
  const root = posix(stores.projectDir, stores.paths.skills)
  return systemWrite(stores.projectDir, [...names.flatMap((name) => [`${root}/${name}`, `${root}/${name}/**`]), '.takt/skill-import/**', '.takt/space-events.jsonl*'], fn)
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)

export function skillRoutes(add: (method: string, path: string, handler: Handler) => void) {
  add('GET', '/api/space/skills/:name/files', async ({ stores, params }): Promise<SkillTree> => {
    const { name, dir } = await skillDir(stores, params.name)
    if (!await isDir(dir)) throw new HttpError(404, `技能 ${name} 不存在`)
    const files = await Promise.all((await walkFiles(dir, 2000)).map(async (f) => ({ ...f, text: f.size <= SKILL_LIMITS.file && isText(await readFile(join(dir, f.path))) })))
    return { name, dir: posix(stores.projectDir, dir), files: files.sort(byPath) }
  })

  add('GET', '/api/space/skills/:name/file', async ({ stores, params, url }): Promise<SkillFileContent> => {
    const { name, path, file } = await skillFile(stores, params.name, url.searchParams.get('path'))
    let data: Buffer
    try { data = await readFile(file) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, '文件不存在')
      if (code === 'EISDIR') throw new HttpError(400, `${path} 是目录`)
      throw error
    }
    const textual = isText(data)
    return { name, path, size: data.length, text: textual, content: textual ? data.toString('utf8') : '' }
  })

  add('PUT', '/api/space/skills/:name/file', async ({ stores, params, url, request }): Promise<SkillFileContent> => {
    authorize(request, stores, 'maintainer')
    const input = await body(request, false, Math.ceil(SKILL_LIMITS.file * 4 / 3) + 64 * 1024)
    const reason = text(input.reason, 'reason')
    const { name, dir, path, file } = await skillFile(stores, params.name, url.searchParams.get('path'))
    const data = typeof input.base64 === 'string' ? Buffer.from(input.base64, 'base64') : Buffer.from(text(input.content, 'content', true), 'utf8')
    if (data.length > SKILL_LIMITS.file) throw new HttpError(413, `单个文件不能超过 ${mb(SKILL_LIMITS.file)}`)
    const textual = isText(data)
    if (path === 'SKILL.md' && !textual) throw new HttpError(400, 'SKILL.md 必须是 UTF-8 文本')
    const present = await isDir(dir)
    if (!present && path !== 'SKILL.md') throw new HttpError(404, `技能 ${name} 不存在；先写它的 SKILL.md`)
    if (await isDir(file)) throw new HttpError(400, `${path} 是目录`)
    if (present) {
      const files = await walkFiles(dir, SKILL_LIMITS.files + 1)
      const previous = files.find((f) => f.path === path)
      if (files.length + (previous ? 0 : 1) > SKILL_LIMITS.files) throw new HttpError(413, `一个技能最多 ${SKILL_LIMITS.files} 个文件`)
      if (files.reduce((n, f) => n + f.size, 0) - (previous?.size ?? 0) + data.length > SKILL_LIMITS.bytes) throw new HttpError(413, `一个技能总共不能超过 ${mb(SKILL_LIMITS.bytes)}`)
    }
    const verb = !present ? '新建技能' : await exists(file) ? '编辑' : '新建'
    return writeSkills(stores, [name], async () => {
      await auditSpace(stores, actor(request, stores), reason, `${verb} ${posix(stores.projectDir, file)}`)
      try { await atomicWrite(file, data) } catch (error) {
        if (['ENOTDIR', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new HttpError(400, `${path} 的上级目录和已有文件重名`)
        throw error
      }
      return { name, path, size: data.length, text: textual, content: textual ? data.toString('utf8') : '' }
    })
  })

  add('DELETE', '/api/space/skills/:name/file', async ({ stores, params, url, request, response }) => {
    authorize(request, stores, 'maintainer')
    const reason = text((await body(request)).reason, 'reason')
    const { name, dir, path, file } = await skillFile(stores, params.name, url.searchParams.get('path'))
    if (path === 'SKILL.md') throw new HttpError(400, 'SKILL.md 不能删；要删就删除整个技能')
    if (!await lstat(file).then((s) => s.isFile(), () => false)) throw new HttpError(404, '文件不存在')
    await writeSkills(stores, [name], async () => {
      await auditSpace(stores, actor(request, stores), reason, `删除 ${posix(stores.projectDir, file)}`)
      await rm(file)
      // 顺手清掉删空的上级目录
      for (let current = dirname(file); current !== dir && current.startsWith(dir); current = dirname(current)) {
        try { await rmdir(current) } catch { break }
      }
    })
    response.writeHead(204); response.end(); return STREAMING
  })

  add('DELETE', '/api/space/skills/:name', async ({ stores, params, request, response }) => {
    authorize(request, stores, 'maintainer')
    const reason = text((await body(request)).reason, 'reason')
    const { name, dir } = await skillDir(stores, params.name)
    if (!await isDir(dir)) throw new HttpError(404, `技能 ${name} 不存在`)
    await writeSkills(stores, [name], async () => {
      await auditSpace(stores, actor(request, stores), reason, `删除技能 ${posix(stores.projectDir, dir)}`)
      await rm(dir, { recursive: true })
    })
    response.writeHead(204); response.end(); return STREAMING
  })

  add('POST', '/api/space/skills/import/preview', async ({ stores, request }) => {
    authorize(request, stores, 'maintainer')
    const input = await body(request, false, Math.ceil(SKILL_LIMITS.upload * 4 / 3) + 1024 * 1024)
    await noLinks(stores, stores.paths.skills)
    return previewImport(input.source as SkillImportSource, stores.projectDir, stores.paths.skills)
  })

  add('POST', '/api/space/skills/import', async ({ stores, request }): Promise<SkillImportResult> => {
    authorize(request, stores, 'maintainer')
    const input = await body(request)
    const reason = text(input.reason, 'reason')
    const item = stagedImport(input.token, stores.projectDir)
    if (!Array.isArray(input.picks) || !input.picks.length) throw new HttpError(400, '至少选一个技能')
    const picks = (input.picks as Array<{ dir?: unknown; name?: unknown }>).map((pick) => {
      const candidate = item.candidates.find((c) => c.dir === pick?.dir)
      if (!candidate) throw new HttpError(400, `预览里没有目录 ${String(pick?.dir)}`)
      if (candidate.problem) throw new HttpError(400, `${candidate.name} 不能导入：${candidate.problem}`)
      return { candidate, name: skillName(pick.name) }
    })
    const names = picks.map((p) => p.name)
    const dupe = names.find((name, i) => names.indexOf(name) !== i)
    if (dupe) throw new HttpError(400, `技能名 ${dupe} 重复了`)
    await noLinks(stores, stores.paths.skills)
    for (const name of names) await noLinks(stores, join(stores.paths.skills, name))
    const taken = (await Promise.all(names.map(async (name) => await exists(join(stores.paths.skills, name)) ? name : ''))).filter(Boolean)
    if (taken.length && input.overwrite !== true) throw new HttpError(409, `空间里已有同名技能：${taken.join('、')}；勾选「覆盖同名技能」或换个名字`)
    const result = await writeSkills(stores, names, async () => {
      await auditSpace(stores, actor(request, stores), reason, `导入技能 ${names.join('、')}（来源 ${item.source}）${taken.length ? `，覆盖 ${taken.join('、')}` : ''}`)
      const work = join(stores.taktDir, 'skill-import', randomBytes(6).toString('hex'))
      await mkdir(work, { recursive: true })
      try {
        const imported: SkillImportResult['imported'] = []
        for (const { candidate, name } of picks) {
          const from = join(item.root, candidate.dir)
          const staging = join(work, name)
          await cp(from, staging, { recursive: true, filter: async (src) => src === from || (!SKIP_NAMES.has(basename(src)) && !(await lstat(src)).isSymbolicLink()) })
          const manifest = join(staging, 'SKILL.md')
          const source = await readFile(manifest, 'utf8')
          if (parseFrontmatter(source).data.name !== name) await writeFile(manifest, withSkillName(source, name))
          imported.push({ name, files: (await walkFiles(staging, SKILL_LIMITS.files)).length, replaced: taken.includes(name) })
        }
        await mkdir(stores.paths.skills, { recursive: true })
        for (const { name } of picks) {
          const target = join(stores.paths.skills, name)
          if (taken.includes(name)) await rename(target, join(work, `${name}.old`))
          await rename(join(work, name), target)
        }
        return { imported }
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    })
    await finishImport(input.token as string)
    return result
  })
}
