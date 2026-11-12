import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { parseFrontmatter, type SkillImportCandidate, type SkillImportPreview, type SkillImportSource } from '@taktflow/core'
import { HttpError } from './http.js'

const execute = promisify(execFile)

/** 单个技能的上限：同步进每个工作目录、算进配方哈希，太大就拖慢每次运行。 */
export const SKILL_LIMITS = { files: 500, bytes: 20 * 1024 * 1024, file: 5 * 1024 * 1024, upload: 30 * 1024 * 1024, entries: 5000 }
/** 只有这么大以内、合法 UTF-8 且不含 NUL 的文件才当文本在线编辑。 */
export const TEXT_LIMIT = 1024 * 1024
/** 不导入、不列出的东西：版本库、系统垃圾、同步标记。 */
export const SKIP_NAMES = new Set(['.git', '.DS_Store', '__MACOSX', 'Thumbs.db', '.takt-skill'])
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const isText = (data: Buffer) => data.length <= TEXT_LIMIT && !data.includes(0) && isUtf8(data)

/** 技能目录内的相对路径：POSIX、不能逃出目录、不碰 .git 和同步标记。 */
export function skillPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new HttpError(400, '文件路径必须是 1–512 个字符')
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) throw new HttpError(400, `文件路径不合法：${value}`)
  for (const seg of value.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new HttpError(400, `文件路径不合法：${value}`)
    if (SKIP_NAMES.has(seg)) throw new HttpError(400, `不能写 ${seg}`)
  }
  return value
}

export function skillName(value: unknown): string {
  if (typeof value !== 'string' || !SKILL_NAME.test(value)) throw new HttpError(400, '技能名只能用字母、数字、点、横线和下划线，最多 64 个字符')
  return value
}

/** 递归列出目录下的普通文件（跳过符号链接和 SKIP_NAMES），超过 max 个就停。 */
export async function walkFiles(dir: string, max: number, skipped?: string[], rel = ''): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = []
  const visit = async (abs: string, prefix: string) => {
    for (const entry of (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length > max) return
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (SKIP_NAMES.has(entry.name)) continue
      if (entry.isSymbolicLink()) { skipped?.push(`${path}（符号链接）`); continue }
      if (entry.isDirectory()) await visit(join(abs, entry.name), path)
      else if (entry.isFile()) out.push({ path, size: (await lstat(join(abs, entry.name))).size })
    }
  }
  await visit(dir, rel)
  return out
}

/** 把 frontmatter 里的 name 改成导入时定的名字（目录名和 name 要一致，harness 按它认技能）。 */
export function withSkillName(text: string, name: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!head) return `---\nname: ${name}\n---\n\n${text}`
  const lines = head[1]!.split(/\r?\n/)
  const at = lines.findIndex((line) => /^name\s*:/.test(line))
  if (at >= 0) lines[at] = `name: ${name}`
  else lines.unshift(`name: ${name}`)
  return `---\n${lines.join('\n')}\n---${text.slice(head[0].length)}`
}

// ---- 来源：Git 仓库 ----

/** 认 GitHub 网页地址（/tree/<分支>/<目录>、/blob/…/SKILL.md）、owner/repo 简写和普通 https / SSH 仓库地址。 */
export function parseGitSource(input: { url: string; ref?: string; path?: string }): { url: string; ref?: string; path?: string; label: string } {
  let url = input.url.trim()
  let ref = input.ref?.trim() || undefined
  let path = input.path?.trim().replace(/^\/+|\/+$/g, '') || undefined
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?$/.exec(url)
  if (gh) {
    url = `https://github.com/${gh[1]}/${gh[2]}.git`
    if (gh[4] && !ref) ref = decodeURIComponent(gh[4])
    if (gh[5] && !path) path = gh[3] === 'blob' ? posix.dirname(decodeURIComponent(gh[5])) : decodeURIComponent(gh[5])
    if (path === '.') path = undefined
  }
  if (!/^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[\w.-]+:[^\s]+)$/.test(url)) throw new HttpError(400, '只支持 https:// 或 SSH（git@… / ssh://）的仓库地址，或 GitHub 的 owner/repo')
  if (ref && (!/^[\w./-]+$/.test(ref) || ref.startsWith('-'))) throw new HttpError(400, `分支 / 标签不合法：${ref}`)
  if (path) skillPath(path)
  const bare = url.replace(/^https:\/\/[^@/]+@/, 'https://').replace(/^https:\/\//, '').replace(/\.git$/, '')
  return { url, ref, path, label: `${bare}${ref ? `@${ref}` : ''}${path ? ` · ${path}` : ''}` }
}

const GIT_TIMEOUT = 4 * 60_000

async function git(args: string[], cwd: string): Promise<void> {
  try {
    await execute('git', ['-c', 'protocol.file.allow=never', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, timeout: GIT_TIMEOUT, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
    })
  } catch (error) {
    const e = error as { stderr?: string; killed?: boolean; message: string }
    if (e.killed) throw new HttpError(504, `拉取仓库超过 ${GIT_TIMEOUT / 60_000} 分钟，已停止；仓库太大的话请在地址里指定技能所在的子目录，或打包成 zip 上传`)
    const detail = (e.stderr || e.message).replace(/\/\/[^@/\s]+@/g, '//').trim().split('\n').filter(Boolean).slice(-2).join(' ')
    throw new HttpError(502, `拉取仓库失败：${detail}`)
  }
}

interface StagedFrom { label: string; base: string; fallback: string; skipped?: string[] }

async function stageGit(source: { url: string; ref?: string; path?: string }, root: string): Promise<StagedFrom> {
  const parsed = parseGitSource(source)
  await git(['init', '-q'], root)
  await git(['remote', 'add', 'origin', parsed.url], root)
  // 指定了子目录就只取那一部分：先只拉目录树，检出时再按稀疏规则取需要的文件
  if (parsed.path) {
    await git(['config', 'core.sparseCheckout', 'true'], root)
    await writeFile(join(root, '.git/info/sparse-checkout'), `/${parsed.path.replace(/[*?[\\]/g, '\\$&')}/\n`)
  }
  await git(['fetch', '-q', '--depth', '1', '--no-tags', ...(parsed.path ? ['--filter=blob:none'] : []), 'origin', parsed.ref ?? 'HEAD'], root)
  await git(['checkout', '-q', 'FETCH_HEAD'], root)
  await rm(join(root, '.git'), { recursive: true, force: true })
  const base = parsed.path ?? ''
  if (base && !await lstat(join(root, base)).then((s) => s.isDirectory(), () => false)) throw new HttpError(404, `仓库里没有目录 ${base}`)
  return { label: parsed.label, base, fallback: basename(base || parsed.url.replace(/\.git$/, '').replace(/.*[/:]/, '')) }
}

// ---- 来源：上传（文件夹 / zip / .skill） ----

/** 极简 zip 读取：中央目录 + stored / deflate，不支持 zip64 和加密；符号链接跳过。 */
export function unzip(buf: Buffer, onEntry: (path: string, data: Buffer) => void, skipped: string[]): void {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new HttpError(400, '不是有效的 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || at === 0xffffffff) throw new HttpError(400, '不支持 zip64，请重新打成普通 zip')
  if (count > SKILL_LIMITS.entries) throw new HttpError(413, `zip 里文件太多（${count} 个）`)
  let total = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new HttpError(400, 'zip 目录损坏')
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10)
    const csize = buf.readUInt32LE(at + 20), usize = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32)
    const mode = buf.readUInt32LE(at + 38) >>> 16, local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if ((mode & 0o170000) === 0o120000) { skipped.push(`${name}（符号链接）`); continue }
    if (flags & 1) throw new HttpError(400, 'zip 加密了，请去掉密码再上传')
    if (usize > SKILL_LIMITS.file) { skipped.push(`${name}（超过 ${SKILL_LIMITS.file / 1024 / 1024} MB）`); continue }
    total += usize
    if (total > SKILL_LIMITS.upload * 2) throw new HttpError(413, 'zip 解开后太大')
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new HttpError(400, 'zip 内容损坏')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    let data: Buffer
    if (method === 0) data = raw
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: usize + 1 }) } catch { throw new HttpError(400, `zip 里的 ${name} 解压失败`) }
    } else throw new HttpError(400, `zip 用了不支持的压缩方式（${method}），请用普通 zip`)
    if (data.length !== usize) throw new HttpError(400, `zip 里的 ${name} 大小不对，文件可能损坏`)
    onEntry(name, data)
  }
}

async function stageUpload(files: Array<{ path: string; base64: string }>, root: string): Promise<StagedFrom> {
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, '没有上传文件')
  const skipped: string[] = []
  const put = async (path: string, data: Buffer) => {
    const segs = path.split('/')
    if (segs.some((seg) => SKIP_NAMES.has(seg))) return
    try { skillPath(path) } catch { skipped.push(`${path}（路径不合法）`); return }
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), data, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST' || error.code === 'EISDIR' || error.code === 'ENOTDIR') skipped.push(`${path}（重名）`)
      else throw error
    })
  }
  let total = 0
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.base64 !== 'string') throw new HttpError(400, '上传文件格式不对：每项要有 path 和 base64')
    const data = Buffer.from(file.base64, 'base64')
    total += data.length
    if (total > SKILL_LIMITS.upload) throw new HttpError(413, `上传内容超过 ${SKILL_LIMITS.upload / 1024 / 1024} MB`)
    // 只有单独拖进来的压缩包才解开；文件夹里带的 zip 当普通资源文件
    if (!file.path.includes('/') && /\.(zip|skill)$/i.test(file.path)) {
      const into = file.path.replace(/\.(zip|skill)$/i, '')
      const entries: Array<[string, Buffer]> = []
      unzip(data, (path, content) => { entries.push([path, content]) }, skipped)
      for (const [path, content] of entries) await put(`${into}/${path}`, content)
    } else await put(file.path, data)
  }
  const names = files.map((f) => f.path)
  const label = names.length === 1 ? names[0]! : `${names[0]!.split('/')[0]} 等 ${names.length} 个文件`
  const top = new Set(names.map((p) => p.split('/')[0]!.replace(/\.(zip|skill)$/i, '')))
  return { label, base: '', fallback: top.size === 1 ? [...top][0]! : 'skill', ...(skipped.length ? { skipped } : {}) }
}

// ---- 暂存与候选 ----

interface Staged { root: string; base: string; space: string; source: string; expires: number; candidates: SkillImportCandidate[] }
const staged = new Map<string, Staged>()
const TTL = 30 * 60_000

function sweep(): void {
  const now = Date.now()
  for (const [token, item] of staged) if (item.expires < now) { staged.delete(token); void rm(item.root, { recursive: true, force: true }) }
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 64) || 'skill'

async function discover(root: string, base: string, fallback: string, skillsDir: string, skipped: string[]): Promise<SkillImportCandidate[]> {
  const found: string[] = []
  const visit = async (rel: string, depth: number) => {
    if (found.length >= 200) return
    const abs = join(root, rel)
    const entries = await readdir(abs, { withFileTypes: true })
    if (entries.some((e) => e.name === 'SKILL.md' && e.isFile())) { found.push(rel); return }
    if (depth >= 8) return
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (e.isDirectory() && !SKIP_NAMES.has(e.name) && e.name !== 'node_modules') await visit(rel ? `${rel}/${e.name}` : e.name, depth + 1)
  }
  await visit(base, 0)
  return Promise.all(found.map(async (dir) => {
    const files = await walkFiles(join(root, dir), SKILL_LIMITS.files, skipped, dir)
    const bytes = files.reduce((n, f) => n + f.size, 0)
    const { data } = parseFrontmatter(await readFile(join(root, dir, 'SKILL.md'), 'utf8'))
    const declared = typeof data.name === 'string' ? data.name.trim() : ''
    const name = SKILL_NAME.test(declared) ? declared : slug(basename(dir) || declared || fallback)
    const big = files.find((f) => f.size > SKILL_LIMITS.file)
    const problem = files.length > SKILL_LIMITS.files ? `文件超过 ${SKILL_LIMITS.files} 个`
      : bytes > SKILL_LIMITS.bytes ? `总大小超过 ${SKILL_LIMITS.bytes / 1024 / 1024} MB`
      : big ? `${big.path} 超过 ${SKILL_LIMITS.file / 1024 / 1024} MB` : undefined
    const exists = await lstat(join(skillsDir, name)).then(() => true, () => false)
    const description = typeof data.description === 'string' ? data.description.trim().slice(0, 300) : ''
    return { dir, name, description, files: files.length, bytes, exists, ...(problem ? { problem } : {}) }
  }))
}

export async function previewImport(source: SkillImportSource, space: string, skillsDir: string): Promise<SkillImportPreview> {
  sweep()
  const root = await mkdtemp(join(tmpdir(), 'takt-skill-import-'))
  try {
    if (source?.kind !== 'git' && source?.kind !== 'upload') throw new HttpError(400, 'source.kind 必须是 git 或 upload')
    if (source.kind === 'git' && typeof source.url !== 'string') throw new HttpError(400, '请填仓库地址')
    const stagedFrom = source.kind === 'git' ? await stageGit(source, root) : await stageUpload(source.files, root)
    const skipped = stagedFrom.skipped ?? []
    const candidates = await discover(root, stagedFrom.base, stagedFrom.fallback, skillsDir, skipped)
    if (!candidates.length) {
      await rm(root, { recursive: true, force: true })
      return { token: '', source: stagedFrom.label, candidates, skipped }
    }
    const token = randomUUID()
    staged.set(token, { root, base: stagedFrom.base, space, source: stagedFrom.label, expires: Date.now() + TTL, candidates })
    return { token, source: stagedFrom.label, candidates, skipped }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export function stagedImport(token: unknown, space: string): Staged {
  sweep()
  const item = typeof token === 'string' ? staged.get(token) : undefined
  if (!item || item.space !== space) throw new HttpError(404, '导入预览已过期，请重新预览一次')
  return item
}

export async function finishImport(token: string): Promise<void> {
  const item = staged.get(token)
  staged.delete(token)
  if (item) await rm(item.root, { recursive: true, force: true })
}
