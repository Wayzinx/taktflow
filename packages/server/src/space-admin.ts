import { constants } from 'node:fs'
import {
  access,
  cp,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initProject,
  openProject,
  requireRole,
  type Actor,
  type CommandRegistry,
  type CommandSpec,
  type ProjectStores,
  type ServerInfo,
  type SpaceCreateRequest,
  type SpaceSummary,
  type SpaceTemplate,
  type SpaceUpdateRequest,
} from '@taktflow/core'
import {
  auditSpace,
  atomicWrite,
  changeConfig,
  checkRepoSource,
  discoverSpaces,
  members,
  repoBinding,
  spaceId,
  spaceSummary,
} from './space.js'
import { spaceLock } from './space-lock.js'
import { HttpError, roleDenied, text } from './http.js'

export interface ServerCommandDeps {
  spacesDir?: string
  projectDir?: string
  onChange?: () => void | Promise<void>
  now?: () => Date
}
const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates')
const templateIds = ['blank', 'standard', 'quick'] as const
export function serverInfo(deps: ServerCommandDeps): ServerInfo {
  const parent = dirname(resolve(deps.projectDir ?? process.cwd()))
  return {
    version: '0.0.0',
    multiSpace: !!deps.spacesDir,
    ...(!deps.spacesDir
      ? { multiSpaceHint: `takt serve --spaces '${parent.replaceAll("'", "'\\''")}'` }
      : {}),
    steward: { configured: false, reason: '管家尚未接入' },
    spaceTemplates: [
      { id: 'blank', title: '空白', description: '配置文件和目录骨架' },
      { id: 'standard', title: '标准交付流水线', description: '标准交付和快速修复' },
      { id: 'quick', title: '快速修复', description: '轻量改动流程' },
    ],
  }
}
export async function initSpace(
  dir: string,
  template: Exclude<SpaceTemplate, object> = 'standard',
  options: { name?: string; layout?: 'space' | 'legacy'; includeLegacyWorkflow?: boolean } = {},
): Promise<ProjectStores> {
  if (!templateIds.includes(template))
    throw new HttpError(400, '模板不合法，请选择 blank、standard 或 quick')
  const existed = await exists(join(dir, 'takt.config.json'))
  const stores = await initProject(dir, options)
  const files =
    template === 'blank'
      ? []
      : template === 'quick'
        ? ['quick-fix.workflow.ts']
        : [
            'taktflow-standard.workflow.ts',
            'quick-fix.workflow.ts',
            ...(options.includeLegacyWorkflow ? ['sdlc.workflow.ts'] : []),
          ]
  if (template !== 'blank') await copyTemplateAssets(stores, template, files)
  const registered = files.map((file) =>
    relative(stores.projectDir, join(stores.paths.workflows, file)),
  )
  stores.config.workflows = [
    ...new Set([...(existed ? stores.config.workflows : []), ...registered]),
  ]
  await atomicWrite(
    join(stores.projectDir, 'takt.config.json'),
    JSON.stringify(stores.config, null, 2) + '\n',
  )
  return stores
}
/** 模板角色、workflow 辅助文件（被相对 import 的 hooks 等）和指定的 workflow 主文件；空间里已有的不覆盖。 */
async function copyTemplateAssets(
  stores: ProjectStores,
  template: 'standard' | 'quick',
  workflows: string[],
): Promise<void> {
  await workflowModuleScope(stores.paths.workflows)
  const quickRoles = new Set([
    'pm.md',
    'dev.md',
    'reviewer.md',
    'verifier.md',
    'lead.md',
    'wiki-writer.md',
  ])
  for (const entry of await readdir(join(templatesDir, 'agents'))) {
    if (
      !entry.endsWith('.md') ||
      entry === 'steward.md' ||
      (template === 'quick' && !quickRoles.has(entry))
    )
      continue
    await copyAbsent(join(templatesDir, 'agents', entry), join(stores.paths.agents, entry))
  }
  // 模板内的相对 import 依赖同目录辅助文件，不能只拷 workflow 主文件。
  for (const entry of await readdir(join(templatesDir, 'workflows'))) {
    if (entry.endsWith('.workflow.ts') && !workflows.includes(entry)) continue
    if (entry.endsWith('.ts'))
      await copyAbsent(join(templatesDir, 'workflows', entry), join(stores.paths.workflows, entry))
  }
}
/** 空间里新建流水线可选的模板（与新建空间的 standard / quick 起点同一份文件）。 */
export const workflowTemplates = {
  'taktflow-standard': { title: '标准交付流水线', roles: 'standard' },
  'quick-fix': { title: '轻量改动交付', roles: 'quick' },
} as const
/**
 * 准备从模板新建流水线：补齐模板用到的角色和辅助文件（已有的不覆盖），返回模板主文件源码。
 * 主文件由调用方改好 id 再写入，所以这里不复制它。
 */
export async function workflowTemplateSource(
  stores: ProjectStores,
  template: keyof typeof workflowTemplates,
): Promise<string> {
  await copyTemplateAssets(stores, workflowTemplates[template].roles, [])
  return readFile(join(templatesDir, 'workflows', `${template}.workflow.ts`), 'utf8')
}
export async function workflowModuleScope(dir: string): Promise<void> {
  // 运行时模板由当前 CLI 提供；仓库外空间也能解析同一份 core，无需安装依赖。
  const modules = join(dir, 'node_modules/@taktflow')
  await mkdir(modules, { recursive: true })
  for (const name of ['core', 'sandbox']) {
    const target = resolve(templatesDir, `../packages/${name}`)
    try {
      await symlink(target, join(modules, name), 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  try {
    await writeFile(join(dir, 'package.json'), '{"type":"module"}\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}
async function copyAbsent(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function rootOf(deps: ServerCommandDeps): string {
  if (!deps.spacesDir)
    throw new HttpError(
      409,
      `单空间模式不能管理空间目录，请使用：${serverInfo(deps).multiSpaceHint}`,
    )
  return resolve(deps.spacesDir)
}
function validId(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id))
    throw new HttpError(409, '空间 ID 须为 2–40 位小写字母、数字或连字符，且以字母或数字开头')
  return id
}
function archivedId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*@\d{8}-\d{6}$/.test(id))
    throw new HttpError(400, '归档 ID 不合法，请从归档列表选择')
  return id
}
async function active(root: string): Promise<ProjectStores[]> {
  return discoverSpaces(root)
}
async function archives(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, '.archive'), { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*@\d{8}-\d{6}$/.test(entry.name),
      )
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
/**
 * 空间管理的操作者。命令表（管家提案）总是带明确身份；全局 HTTP 接口没选"我是"时传函数（http.ts 的 globalActor），
 * 按被操作的空间推断成它的第一个 owner，和空间内接口一致；推断不出时为 undefined，不冒充成员、不写进新空间。
 */
export type SpaceAuthor = Actor | ((space?: Pick<ProjectStores, 'config'>) => Actor | undefined)
const ANONYMOUS: Actor = { type: 'human', id: 'web' }
const who = (author: SpaceAuthor, space?: Pick<ProjectStores, 'config'>) =>
  typeof author === 'function' ? author(space) : author
function adminRole(
  stores: ProjectStores,
  author: SpaceAuthor,
  role: 'maintainer' | 'owner',
  operation: string,
): Actor {
  const by = who(author, stores) ?? ANONYMOUS
  if (by.type === 'human' && by.id === 'web') throw new HttpError(403, '匿名身份 web 不能管理空间，请选择真实成员身份')
  try {
    requireRole(stores, by, role, operation)
  } catch {
    throw roleDenied(stores, by, role, operation, `「${stores.config.project.name}」`)
  }
  return by
}
async function checkedDir(root: string, id: string): Promise<string> {
  const dir = join(root, id)
  try {
    for (const path of [root, dir])
      if ((await lstat(path)).isSymbolicLink()) throw new HttpError(400, '空间目录不能是符号链接')
    await access(join(dir, 'takt.config.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new HttpError(404, '空间不存在，请刷新空间列表')
    throw error
  }
  return dir
}
const normalizedName = (name: string) => name.replace(/\s/g, '').toLocaleLowerCase()
function uniqueName(spaces: ProjectStores[], name: string, except?: string): string {
  const value = text(name, 'name').trim()
  if (
    spaces.some(
      (item) =>
        spaceId(item) !== except &&
        normalizedName(item.config.project.name) === normalizedName(value),
    )
  )
    throw new HttpError(409, '空间名称重复，请修改名称')
  return value
}
async function adminAudit(
  root: string,
  author: Actor,
  reason: string,
  message: string,
): Promise<void> {
  await auditSpace({ taktDir: join(root, '.takt') }, author, reason, message, 'space-admin.jsonl')
}
async function ensureIdle(stores: ProjectStores): Promise<void> {
  if ((await stores.runs.list()).some((run) => ['running', 'waiting_human'].includes(run.status)))
    throw new HttpError(409, '空间仍有运行中的需求，请先取消运行')
}
async function copyTree(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) return
  const rejectLinks = async (path: string): Promise<void> => {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new HttpError(400, '复制来源不能包含符号链接')
    if (stat.isDirectory())
      for (const name of await readdir(path)) {
        if (name !== 'node_modules') await rejectLinks(join(path, name))
      }
  }
  await rejectLinks(source)
  await cp(source, destination, {
    recursive: true,
    filter: (path) => basename(path) !== 'node_modules',
  })
}
function spaceCreateReason(
  input: Pick<SpaceCreateRequest, 'id' | 'reason'>,
  reason?: string,
): string {
  if (reason !== undefined) text(reason, 'reason', true)
  if (input.reason !== undefined) text(input.reason, 'reason', true)
  return reason?.trim() ? reason : input.reason?.trim() ? input.reason : `新建空间 ${input.id}`
}
export async function createSpace(
  deps: ServerCommandDeps,
  input: SpaceCreateRequest,
  author: SpaceAuthor,
  reason?: string,
): Promise<SpaceSummary> {
  const root = rootOf(deps)
  reason = spaceCreateReason(input, reason)
  if (typeof author !== 'function' && author.type !== 'human')
    throw new HttpError(403, '新建空间必须由人确认')
  if (typeof author !== 'function' && author.type === 'human' && author.id === 'web')
    throw new HttpError(403, '匿名身份 web 不能创建空间，请选择真实成员身份')
  return spaceLock(join(root, '.takt/space-admin'), async () => {
    const id = validId(input.id),
      spaces = await active(root)
    const name = uniqueName(spaces, input.name)
    if (
      spaces.some((space) => spaceId(space) === id) ||
      (await exists(join(root, id))) ||
      (await archives(root)).some((entry) => entry.startsWith(id + '@'))
    )
      throw new HttpError(409, '空间 ID 已被活动或归档空间占用，请更换 ID')
    for (const key of ['description', 'color'] as const)
      if (input[key] !== undefined) text(input[key], key, true)
    if (input.repos !== undefined && !Array.isArray(input.repos))
      throw new HttpError(400, 'repos 必须是数组')
    const template = input.template
    if (
      typeof template !== 'string' &&
      (!template ||
        !Array.isArray(template.parts) ||
        template.parts.some(
          (part) =>
            !['agents', 'skills', 'workflows', 'knowledge', 'models', 'members'].includes(part),
        ))
    )
      throw new HttpError(400, '复制空间 parts 不合法')
    const source =
      typeof template === 'object'
        ? spaces.find((item) => spaceId(item) === template.copyFrom)
        : undefined
    if (typeof template === 'object' && !source) throw new HttpError(404, '复制来源空间不存在')
    if (source) adminRole(source, author, 'maintainer', '复制这个空间')
    // 创建者：明确身份就是它；没选身份时取请求成员里的第一个 owner（向导第 3 步显示的"创建者"），
    // 其次复制来源 / 缺省空间的 owner。都没有就拒绝创建，绝不留下匿名开放空间。
    const requested = input.members === undefined ? [] : members(input.members)
    if (requested.some((member) => member.id === 'web')) throw new HttpError(400, 'web 是匿名身份，不能添加为空间成员')
    const resolved =
      who(author, { config: { members: requested } } as Pick<ProjectStores, 'config'>) ??
      who(author, source)
    const creator = resolved?.type === 'human' ? resolved : undefined
    if (!creator || creator.id === 'web') throw new HttpError(403, '无法确定创建者身份，请选择真实成员身份后创建空间')
    const mine = requested.find((member) => member.id === creator?.id)
    const assigned = [
      ...requested.filter((member) => member !== mine),
      ...(creator
        ? [{ ...mine, id: creator.id, name: mine?.name ?? creator.id, role: 'owner' as const }]
        : []),
    ]
    const repos = await Promise.all(
      (input.repos ?? []).map(async (repo, index) => {
        const binding = repoBinding({
          ...repo,
          id: repo.id ?? `repo-${index + 1}`,
          path: repo.path ?? `.takt/repos/${repo.id ?? `repo-${index + 1}`}`,
          defaultBranch: repo.defaultBranch ?? 'main',
        })
        await checkRepoSource({ projectDir: join(root, id) }, binding)
        return binding
      }),
    )
    const dir = join(root, id)
    try {
      const stores = await initSpace(dir, typeof template === 'string' ? template : 'blank', {
        name,
      })
      if (source && typeof template === 'object')
        for (const part of template.parts) {
          if (['agents', 'skills', 'workflows', 'knowledge'].includes(part))
            await copyTree(
              source.paths[part as 'agents' | 'skills' | 'workflows' | 'knowledge'],
              stores.paths[part as 'agents' | 'skills' | 'workflows' | 'knowledge'],
            )
          if (part === 'workflows') await workflowModuleScope(stores.paths.workflows)
          if (part === 'workflows')
            stores.config.workflows = (await readdir(stores.paths.workflows))
              .filter((file) => file.endsWith('.workflow.ts'))
              .map((file) => relative(dir, join(stores.paths.workflows, file)))
          if (part === 'knowledge') {
            stores.config.knowledgeBindings = structuredClone(source.config.knowledgeBindings)
            await resetCopiedKnowledge(stores.paths.knowledge)
          }
          if (part === 'models')
            for (const key of ['models', 'providers', 'roles', 'harnesses'] as const)
              Object.assign(stores.config, { [key]: structuredClone(source.config[key]) })
          if (part === 'members' && input.members === undefined)
            stores.config.members = structuredClone(source.config.members)
        }
      stores.config.project = { name, description: input.description, color: input.color }
      stores.config.space = { ...stores.config.space, id }
      stores.config.members =
        input.members !== undefined
          ? assigned
          : [
              ...new Map(
                [...(stores.config.members ?? []).filter((member) => member.id !== 'web'), ...assigned].map((member) => [
                  member.id,
                  member,
                ]),
              ).values(),
            ]
      stores.config.repos = repos
      await atomicWrite(
        join(dir, 'takt.config.json'),
        JSON.stringify(stores.config, null, 2) + '\n',
      )
      await adminAudit(root, creator ?? ANONYMOUS, reason, `space.create ${id}`)
      await deps.onChange?.()
      return spaceSummary(stores)
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  })
}
export async function updateSpace(
  deps: ServerCommandDeps,
  id: string,
  input: SpaceUpdateRequest,
  author: SpaceAuthor,
): Promise<SpaceSummary> {
  text(input.reason, 'reason')
  const root = deps.spacesDir ? rootOf(deps) : resolve(deps.projectDir ?? process.cwd())
  return spaceLock(join(root, '.takt/space-admin'), async () => {
    const spaces = deps.spacesDir ? await active(root) : [await openProject(root)],
      stores = spaces.find((item) => spaceId(item) === id)
    if (!stores) throw new HttpError(404, '空间不存在')
    const by = adminRole(stores, author, 'maintainer', '修改空间信息')
    const name = input.name === undefined ? undefined : uniqueName(spaces, input.name, id)
    await changeConfig(stores, by, input.reason, `space.update ${id}`, (config) => {
      for (const key of ['description', 'color'] as const)
        if (input[key] !== undefined) config.project[key] = text(input[key], key, true)
      if (name !== undefined) config.project.name = name
    })
    if (deps.spacesDir) await adminAudit(root, by, input.reason, `space.update ${id}`)
    await deps.onChange?.()
    return spaceSummary(stores)
  })
}
export async function listSpaces(
  deps: ServerCommandDeps,
  includeArchived = false,
): Promise<SpaceSummary[]> {
  const spaces = deps.spacesDir
    ? await active(rootOf(deps))
    : [await openProject(deps.projectDir ?? process.cwd())]
  const result = includeArchived ? [] : await Promise.all(spaces.map(spaceSummary))
  if (includeArchived && deps.spacesDir)
    for (const id of await archives(rootOf(deps))) {
      const stores = await openProject(await checkedDir(join(rootOf(deps), '.archive'), id))
      const time = id.slice(id.indexOf('@') + 1)
      result.push({
        ...(await spaceSummary(stores)),
        id,
        archived: true,
        archivedAt: `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}Z`,
      })
    }
  return result
}
export async function archiveSpace(
  deps: ServerCommandDeps,
  id: string,
  author: SpaceAuthor,
  reason: string,
): Promise<SpaceSummary> {
  const root = rootOf(deps)
  text(reason, 'reason')
  return spaceLock(join(root, '.takt/space-admin'), async () => {
    const stores = (await active(root)).find((item) => spaceId(item) === id)
    if (!stores) throw new HttpError(404, '空间不存在')
    const by = adminRole(stores, author, 'maintainer', '归档空间')
    await ensureIdle(stores)
    const stamp = (deps.now?.() ?? new Date())
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 15)
    const archived = `${basename(stores.projectDir)}@${stamp}`,
      destination = join(root, '.archive', archived)
    await mkdir(join(root, '.archive'), { recursive: true })
    if (await exists(destination)) throw new HttpError(409, '同秒归档记录已存在，请稍后重试')
    await checkedDir(root, basename(stores.projectDir))
    await adminAudit(root, by, reason, `space.archive ${id} -> ${archived}`)
    const info = await spaceSummary(stores)
    await rename(stores.projectDir, destination)
    await deps.onChange?.()
    return {
      ...info,
      id: archived,
      archived: true,
      archivedAt: (deps.now?.() ?? new Date()).toISOString(),
    }
  })
}
export async function restoreSpace(
  deps: ServerCommandDeps,
  id: string,
  author: SpaceAuthor,
  reason: string,
): Promise<SpaceSummary> {
  const root = rootOf(deps)
  text(reason, 'reason')
  return spaceLock(join(root, '.takt/space-admin'), async () => {
    const source = await checkedDir(join(root, '.archive'), archivedId(id)),
      stores = await openProject(source)
    const by = adminRole(stores, author, 'maintainer', '恢复空间')
    const original = id.split('@')[0]!
    if (
      (await exists(join(root, original))) ||
      (await active(root)).some((item) => spaceId(item) === spaceId(stores))
    )
      throw new HttpError(409, '原空间 ID 已被占用，请先解决冲突')
    try {
      uniqueName(await active(root), stores.config.project.name)
    } catch {
      throw new HttpError(
        409,
        `活动空间名称“${stores.config.project.name}”已被占用，请先重命名同名活动空间后恢复`,
      )
    }
    await adminAudit(root, by, reason, `space.restore ${id}`)
    await rename(source, join(root, original))
    await deps.onChange?.()
    return spaceSummary(await openProject(join(root, original)))
  })
}
export async function deleteSpace(
  deps: ServerCommandDeps,
  id: string,
  confirm: string,
  author: SpaceAuthor,
  reason: string,
): Promise<{ deleted: string }> {
  const root = rootOf(deps)
  text(reason, 'reason')
  archivedId(id)
  if (confirm !== id) throw new HttpError(409, '确认 ID 不匹配，请输入完整归档 ID')
  return spaceLock(join(root, '.takt/space-admin'), async () => {
    const dir = await checkedDir(join(root, '.archive'), id),
      stores = await openProject(dir)
    const by = adminRole(stores, author, 'owner', '彻底删除空间')
    await adminAudit(root, by, reason, `space.delete ${id}`)
    await rm(dir, { recursive: true })
    return { deleted: id }
  })
}
export function createServerCommandRegistry(deps: ServerCommandDeps): CommandRegistry {
  const str = { type: 'string' }
  const schema = (properties: Record<string, unknown>, required: string[]) => ({
    type: 'object',
    properties,
    required,
  })
  const define = (
    id: string,
    title: string,
    input: Record<string, unknown>,
    handler: CommandSpec['handler'],
    risk: CommandSpec['risk'] = 'write',
  ): CommandSpec => ({
    id,
    title,
    input,
    handler,
    kind: 'command',
    risk,
    minRole: 'maintainer',
  })
  const specs = [
    define(
      'space.create',
      '新建空间',
      schema(
        {
          id: str,
          name: str,
          description: str,
          color: str,
          template: {
            oneOf: [
              { type: 'string', enum: templateIds },
              schema(
                {
                  copyFrom: str,
                  parts: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['agents', 'skills', 'workflows', 'knowledge', 'models', 'members'],
                    },
                  },
                },
                ['copyFrom', 'parts'],
              ),
            ],
          },
          repos: {
            type: 'array',
            items: schema({ id: str, path: str, url: str, defaultBranch: str }, []),
          },
          members: {
            type: 'array',
            items: schema(
              {
                id: str,
                name: str,
                role: { type: 'string', enum: ['owner', 'maintainer', 'member', 'viewer'] },
              },
              ['id', 'name', 'role'],
            ),
          },
        },
        ['id', 'name', 'template'],
      ),
      (input, ctx) =>
        createSpace(deps, input as unknown as SpaceCreateRequest, ctx.actor, ctx.reason),
    ),
    define(
      'space.update',
      '修改空间',
      schema({ id: str, name: str, description: str, color: str }, ['id']),
      (input, ctx) =>
        updateSpace(deps, input.id as string, { ...input, reason: ctx.reason! }, ctx.actor),
    ),
    define('space.archive', '归档空间', schema({ id: str }, ['id']), (input, ctx) =>
      archiveSpace(deps, input.id as string, ctx.actor, ctx.reason!),
    ),
    define('space.restore', '恢复空间', schema({ id: str }, ['id']), (input, ctx) =>
      restoreSpace(deps, input.id as string, ctx.actor, ctx.reason!),
    ),
    define(
      'space.delete',
      '删除已归档空间',
      schema({ id: str, confirm: str }, ['id', 'confirm']),
      (input, ctx) =>
        deleteSpace(deps, input.id as string, input.confirm as string, ctx.actor, ctx.reason!),
      'dangerous',
    ),
  ]
  return {
    list: () => specs.map(({ handler: _, ...info }) => structuredClone(info)),
    async run(id, input, context) {
      let response: Awaited<ReturnType<CommandRegistry['run']>>
      try {
        const spec = specs.find((item) => item.id === id)
        if (!spec) throw new Error(`命令不存在：${id}`)
        if (id === 'space.create')
          context = {
            ...context,
            reason: spaceCreateReason(input as unknown as SpaceCreateRequest, context.reason),
          }
        text(context.reason, 'reason')
        if (context.actor.type !== 'human') throw new HttpError(403, '空间管理必须由人确认')
        for (const key of spec.input.required as string[])
          if (!Object.hasOwn(input, key)) throw new HttpError(400, `缺少字段：${key}`)
        if (deps.spacesDir)
          await adminAudit(
            rootOf(deps),
            context.actor,
            context.reason!,
            JSON.stringify({ id, input, phase: 'requested' }),
          )
        const result = await spec.handler(input, context)
        response = { ok: true, message: `${spec.title}已执行`, result }
      } catch (error) {
        response = { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      if (deps.spacesDir)
        await adminAudit(
          rootOf(deps),
          context.actor,
          context.reason?.trim() ? context.reason : '命令校验拒绝',
          JSON.stringify({ id, phase: 'finished', response }),
        )
      return response
    },
  }
}

async function resetCopiedKnowledge(root: string): Promise<void> {
  const { readJsonFile, writeFileAtomic } = await import('@taktflow/core')
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(root, entry.name, 'kb.json')
    const base = await readJsonFile<import('@taktflow/core').KnowledgeBase>(file)
    if (!base) continue
    base.status = 'draft'
    base.version = 0
    delete base.candidateVersion
    delete base.builtAt
    delete base.publishedAt
    delete base.stats
    delete base.error
    await writeFileAtomic(file, JSON.stringify(base, null, 2) + '\n')
  }
}
