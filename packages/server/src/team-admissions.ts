import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256 } from '@taktflow/core'
import { HttpError, text } from './http.js'
import { teamId } from './team-hub.js'
import { checkTeamPath, missingFile, storagePath, teamFileLock, writeTeamJson } from './team-storage.js'

export const LINK_TTL_MS = 10 * 60_000
export const WORKER_TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const DIGEST = /^[a-f0-9]{64}$/
const newSecret = () => randomBytes(32).toString('base64url')

interface StaticAdmission { nodeId: string; harness: string; tokenHash: string }
interface Computer { displayName: string; platform: 'mac' | 'linux' }
interface Pending extends Partial<Computer> { nodeId: string; harness: 'codex'; codeHash: string; expiresAt: number }
interface Enrolled extends Partial<Computer> { nodeId: string; harness: 'codex'; tokenHash: string; generation: string }
type Link = Pending | Enrolled
type Registry = Map<string, Link>

function digestMatches(digest: string, secret: string): boolean {
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(sha256(secret), 'hex'))
}

function staticAdmissions(raw: string | undefined): Map<string, Map<string, StaticAdmission>> {
  const spaces = new Map<string, Map<string, StaticAdmission>>()
  if (raw === undefined) return spaces
  const used = new Set<string>()
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error()
    for (const entry of value) {
      const { spaceId, nodeId, harness, token } = entry ?? {}
      if (typeof token !== 'string' || !WORKER_TOKEN.test(token) || used.has(token)) throw new Error()
      const space = teamId(text(spaceId, 'spaceId'))
      const node = teamId(text(nodeId, 'nodeId'))
      const roster = spaces.get(space) ?? new Map<string, StaticAdmission>()
      if (roster.has(node)) throw new Error()
      roster.set(node, { nodeId: node, harness: teamId(text(harness, 'harness')), tokenHash: sha256(token) })
      spaces.set(space, roster)
      used.add(token)
    }
    return spaces
  } catch {
    throw new Error('TAKT_TEAM_NODES 必须是合法的 [{spaceId,nodeId,harness,token}]，节点与 32–256 字符的 URL-safe token 不可重复')
  }
}

export function computerDetails(name: unknown, platform: unknown): Computer {
  const displayName = text(name, 'displayName').trim()
  if (displayName.length > 64 || /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(displayName)) {
    throw new HttpError(400, '电脑名称最多 64 个字符，且必须为单行')
  }
  if (platform !== 'mac' && platform !== 'linux') throw new HttpError(400, 'Link 仅支持 Mac 和 Linux')
  return { displayName, platform }
}

function decodeRegistry(value: { version: number; links: Link[] }): Registry {
  if (value?.version !== 1 || !Array.isArray(value.links)) throw new Error('Team Link 注册表格式不合法')
  const records: Registry = new Map()
  for (const record of value.links) {
    if (!record || typeof record.nodeId !== 'string' || teamId(record.nodeId) !== record.nodeId || record.harness !== 'codex' || records.has(record.nodeId)) {
      throw new Error('Team Link 设备格式不合法')
    }
    if (record.displayName !== undefined || record.platform !== undefined) computerDetails(record.displayName, record.platform)
    const valid = 'codeHash' in record
      ? typeof record.codeHash === 'string' && DIGEST.test(record.codeHash) && Number.isSafeInteger(record.expiresAt) && !('tokenHash' in record) && !('generation' in record)
      : typeof record.tokenHash === 'string' && DIGEST.test(record.tokenHash) && typeof record.generation === 'string' && record.generation.length > 0
    if (!valid) throw new Error('Team Link 凭据格式不合法')
    records.set(record.nodeId, record)
  }
  return records
}

export class TeamAdmissions {
  readonly env: ReturnType<typeof staticAdmissions>
  private readonly root: string

  constructor(root: string, raw: string | undefined) {
    this.root = storagePath(root)
    this.env = staticAdmissions(raw)
  }

  private file(space: string): string { return join(this.root, `${sha256(space)}.json`) }

  private async checkRoot(create = false): Promise<boolean> {
    await checkTeamPath(this.root)
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root).catch(error => { if (!missingFile(error)) throw error })
    if (!info) return false
    if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
      throw new Error('Team Link 目录必须仅由 Hub 用户访问')
    }
    return true
  }

  async read(space: string): Promise<Registry | undefined> {
    if (!await this.checkRoot()) return
    const file = await open(this.file(space), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(error => { if (!missingFile(error)) throw error })
    if (!file) return
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink > 1 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
        throw new Error('Team Link 注册表必须是私有普通文件')
      }
      return decodeRegistry(JSON.parse(await file.readFile('utf8')))
    } catch { throw new Error('无法读取 Team Link 注册表') }
    finally { await file.close() }
  }

  private async write(space: string, links: Registry): Promise<void> {
    await this.checkRoot()
    await writeTeamJson(this.file(space), { version: 1, links: [...links.values()] })
  }

  private async locked<T>(space: string, create: boolean, fn: (records: Registry, exists: boolean) => Promise<T>): Promise<T> {
    if (!await this.checkRoot(create)) return fn(new Map(), false)
    return teamFileLock(this.file(space), async () => {
      const records = await this.read(space)
      return fn(records ?? new Map(), records !== undefined)
    })
  }

  issue(space: string, nodeId: string, reset: () => Promise<void>, computer?: Computer) {
    return this.locked(space, true, async records => {
      const current = records.get(nodeId)
      if (this.env.get(space)?.has(nodeId) || (current && 'tokenHash' in current)) {
        throw new HttpError(409, '此节点 ID 已登记')
      }
      await reset()
      for (const [id, link] of records) {
        if ('expiresAt' in link && link.expiresAt <= Date.now()) records.delete(id)
      }
      const details = computer ?? (current && { displayName: current.displayName, platform: current.platform })
      const code = newSecret()
      const expiresAt = Date.now() + LINK_TTL_MS
      records.set(nodeId, { ...details, nodeId, harness: 'codex', codeHash: sha256(code), expiresAt })
      await this.write(space, records)
      return { ...details, nodeId, harness: 'codex', code, expiresAt: new Date(expiresAt).toISOString() }
    })
  }

  exchange(space: string, nodeId: string, code: string) {
    return this.locked(space, false, async records => {
      const record = records.get(nodeId)
      if (this.env.get(space)?.has(nodeId) || !record || !('codeHash' in record) || record.expiresAt <= Date.now() || !digestMatches(record.codeHash, code)) {
        throw new HttpError(401, 'Team Link 连接码无效或已失效')
      }
      const token = newSecret()
      records.set(nodeId, { nodeId, harness: 'codex', displayName: record.displayName, platform: record.platform, tokenHash: sha256(token), generation: randomUUID() })
      await this.write(space, records)
      return { token }
    })
  }

  revoke(space: string, nodeId: string, reset: () => Promise<void>) {
    return this.locked(space, false, async records => {
      if (this.env.get(space)?.has(nodeId)) throw new HttpError(409, '环境变量登记的节点不可在此撤销')
      if (!records.has(nodeId)) throw new HttpError(404, '节点不存在')
      await reset()
      records.delete(nodeId)
      await this.write(space, records)
      return { ok: true }
    })
  }

  authorize<T>(space: string, nodeId: string, token: string | undefined, use: (admission: StaticAdmission | Enrolled) => Promise<T>): Promise<T> {
    const useIfValid = async (admission: StaticAdmission | Link | undefined) => {
      if (!admission || !('tokenHash' in admission) || !token || !digestMatches(admission.tokenHash, token)) {
        throw new HttpError(401, 'Worker 凭据不匹配')
      }
      return use(admission)
    }
    const env = this.env.get(space)?.get(nodeId)
    if (env) return useIfValid(env)
    return this.locked(space, false, (records, exists) => {
      if (this.env.size === 0 && !exists) throw new HttpError(404, 'Worker API 不存在')
      return useIfValid(records.get(nodeId))
    })
  }
}
