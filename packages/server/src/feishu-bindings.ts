import { assertNoSymlinks } from '@taktflow/core'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { spaceLock } from './space-lock.js'
import { body, HttpError, requestUser, requires, roleDenied, safeId } from './http.js'
import type { Handler, RequestContext } from './routes.js'
import { spaceId } from './space.js'

export interface FeishuBinding {
  chatId: string
  members: Array<{ openId: string; memberId: string }>
  revision: string
  updatedAt: string
}

type BindingInput = Pick<FeishuBinding, 'chatId' | 'members'>

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function bindingInput(chatId: unknown, members: unknown): BindingInput {
  if (typeof chatId !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(chatId)) throw new HttpError(400, 'chatId 必须是 oc_ 开头的飞书会话 ID')
  if (!Array.isArray(members)) throw new HttpError(400, 'members 必须是成员映射数组')
  const openIds = new Set<string>()
  const memberIds = new Set<string>()
  return { chatId, members: members.map((member: unknown) => {
    if (!isRecord(member) || typeof member.openId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(member.openId) || typeof member.memberId !== 'string') {
      throw new HttpError(400, '成员映射必须包含 ou_ 开头的 openId 和有效的 memberId')
    }
    const { openId, memberId } = member
    safeId(memberId)
    if (openIds.has(openId) || memberIds.has(memberId)) throw new HttpError(400, '飞书成员映射中的 openId 和 memberId 不可重复')
    openIds.add(openId)
    memberIds.add(memberId)
    return { openId, memberId }
  }) }
}

function sameMembers(current: FeishuBinding, next: BindingInput): boolean {
  if (current.members.length !== next.members.length) return false
  const existing = new Map(current.members.map(({ openId, memberId }) => [openId, memberId]))
  return next.members.every(({ openId, memberId }) => existing.get(openId) === memberId)
}

function decodeRegistry(data: string): Map<string, FeishuBinding> {
  const parsed: unknown = JSON.parse(data)
  if (!isRecord(parsed)) throw new Error('无效的飞书绑定注册表')
  const chatIds = new Set<string>()
  const bindings = new Map<string, FeishuBinding>()
  for (const [id, entry] of Object.entries(parsed)) {
    if (!isRecord(entry) || typeof entry.revision !== 'string' || !entry.revision || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error('无效的飞书绑定记录')
    const input = bindingInput(entry.chatId, entry.members)
    if (chatIds.has(input.chatId)) throw new Error('飞书绑定注册表含重复会话 ID')
    chatIds.add(input.chatId)
    bindings.set(safeId(id), { ...input, revision: entry.revision, updatedAt: entry.updatedAt })
  }
  return bindings
}

export class FeishuBindings {
  private readonly root: string
  private readonly file: string

  constructor(root: string) {
    const absolute = resolve(root)
    this.root = process.platform === 'darwin' && /^\/(?:var|tmp)\//.test(absolute) ? `/private${absolute}` : absolute
    this.file = join(this.root, 'bindings.json')
  }

  async get(spaceId: string): Promise<FeishuBinding | null> {
    return (await this.read()).get(spaceId) ?? null
  }

  async find(chatId: string): Promise<{ spaceId: string; binding: FeishuBinding } | undefined> {
    for (const [spaceId, binding] of await this.read()) if (binding.chatId === chatId) return { spaceId, binding }
    return undefined
  }

  async update(spaceId: string, next: BindingInput | null, baseRevision: string | null): Promise<FeishuBinding | null> {
    safeId(spaceId)
    const input = next && bindingInput(next.chatId, next.members)
    await this.checkRoot(true)
    await assertNoSymlinks(this.root, join(this.root, 'bindings.lock'))
    return spaceLock(join(this.root, 'bindings'), async () => {
      const bindings = await this.read()
      const current = bindings.get(spaceId)
      if ((current?.revision ?? null) !== baseRevision) throw new HttpError(409, '飞书绑定已更新，请刷新后重试')
      if (!input && !current) return null
      if (input && current?.chatId === input.chatId && sameMembers(current, input)) return current
      if (input && [...bindings].some(([id, binding]) => id !== spaceId && binding.chatId === input.chatId)) {
        throw new HttpError(409, '该飞书会话已绑定到其他空间')
      }
      const binding = input && { ...input, revision: randomUUID(), updatedAt: new Date().toISOString() }
      if (binding) bindings.set(spaceId, binding)
      else bindings.delete(spaceId)
      await this.write(bindings)
      return binding
    })
  }

  private async checkRoot(create = false): Promise<void> {
    await assertNoSymlinks(parse(this.root).root, this.root)
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root).catch(error => { if (!isMissing(error)) throw error })
    if (info && (!info.isDirectory() || info.mode & 0o022 || (process.getuid && info.uid !== process.getuid()))) {
      throw new Error('飞书绑定目录必须由 Hub 用户拥有且不可被其他用户写入')
    }
  }

  private async read(): Promise<Map<string, FeishuBinding>> {
    await this.checkRoot()
    const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (!isMissing(error)) throw new Error('无法打开飞书绑定注册表', { cause: error })
    })
    if (!file) return new Map()
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink > 1) throw new Error('飞书绑定注册表必须是普通文件')
      return decodeRegistry(await file.readFile('utf8'))
    } catch (error) { throw new Error('无法读取飞书绑定注册表', { cause: error }) }
    finally { await file.close() }
  }

  private async write(bindings: Map<string, FeishuBinding>): Promise<void> {
    const tmp = join(this.root, `bindings-${randomUUID()}.tmp`)
    const file = await open(tmp, 'wx', 0o600)
    try {
      try {
        await file.writeFile(`${JSON.stringify(Object.fromEntries(bindings), null, 2)}\n`)
        await file.sync()
      } finally { await file.close() }
      await rename(tmp, this.file)
    } finally { await rm(tmp, { force: true }) }
  }
}

export function feishuBindingRoutes(add: (method: string, path: string, handler: Handler) => void, bindings: FeishuBindings, configured: boolean): void {
  const path = '/api/space/feishu'
  const what = '管理飞书绑定'
  function owner({ request, stores }: RequestContext) {
    const id = requestUser(request)
    const members = stores.config.members ?? []
    if (!id || id === 'web' || !members.some(member => member.id === id && member.role === 'owner')) {
      throw roleDenied(stores, { type: 'human', id: id ?? 'web' }, 'owner', what)
    }
    return members
  }
  add('GET', path, async (context) => {
    owner(context)
    return { configured, binding: await bindings.get(spaceId(context.stores)) }
  })
  add('PUT', path, requires('owner', what, async (context: RequestContext) => {
    const members = owner(context)
    const { chatId, members: mapping, baseRevision } = await body(context.request)
    if (baseRevision !== null && (typeof baseRevision !== 'string' || !baseRevision.trim())) throw new HttpError(400, 'baseRevision 必须是非空字符串或 null')
    const next = chatId === null ? null : bindingInput(chatId, mapping)
    const memberIds = new Set(members.filter(member => member.id !== 'web').map(member => member.id))
    if (next?.members.some(member => !memberIds.has(member.memberId))) throw new HttpError(400, '飞书成员映射必须指向当前空间的成员')
    return { configured, binding: await bindings.update(spaceId(context.stores), next, baseRevision) }
  }))
}
