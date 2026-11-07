import type { CrudCliOptions } from './req.js'
import { archiveSpace, createSpace, deleteSpace, restoreSpace, convertWorkflow } from '@taktflow/server'
import { cliActor } from '../actor.js'
import { cp, lstat, mkdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { listSkills, type Actor, type WorkflowEdit, type WorkflowEditRequest, type RoomMessage } from '@taktflow/core'
import { auditSpace, changeConfig, discoverSpaces, members, repoBinding, repoManager, spaceSummary, workflowStore } from '@taktflow/server'
import { expectPositionals, UsageError, type ParsedCli } from '../args.js'
import { postToLead } from '../lead.js'
import { loadRuntime, openStores } from '../project.js'
import { createPrinter } from '../output.js'

export async function runSpaceCommand(cli: ParsedCli): Promise<number> {
  const { command, positionals: args, options } = cli
  const extra = options as typeof options & CrudCliOptions
  const [sub, ...rest] = args
  const printer = createPrinter(options.json)
  let result: unknown
  if (command === 'space') {
    if (sub === 'ls') {
      expectPositionals('space ls', rest, 0, 1)
      const spaces = await discoverSpaces(options.spaces ?? rest[0] ?? options.project ?? process.cwd())
      result = await Promise.all(spaces.map(spaceSummary))
    } else {
      expectPositionals(`space ${sub}`, rest, 1)
      if (!options.spaces) throw new UsageError('空间管理需要 --spaces <根目录>')
      const deps = { spacesDir: resolve(options.spaces) }, reason = options.reason ?? `CLI space ${sub}`
      const author: Actor = { type: 'human', id: process.env.TAKT_USER ?? process.env.USER ?? 'cli' }
      if (sub === 'new') {
        if (!options.name) throw new UsageError('space new 需要 --name <名称>')
        const parts = (extra.parts ?? '').split(',').filter(Boolean) as Array<'agents' | 'skills' | 'workflows' | 'knowledge' | 'models' | 'members'>
        result = await createSpace(deps, { id: rest[0]!, name: options.name, color: extra.color,
          template: extra.from ? { copyFrom: extra.from, parts } : (extra.template ?? 'blank') as 'blank' | 'standard' | 'quick', reason }, author)
      } else if (sub === 'archive') result = await archiveSpace(deps, rest[0]!, author, reason)
      else if (sub === 'restore') result = await restoreSpace(deps, rest[0]!, author, reason)
      else if (sub === 'rm') {
        if (!extra.confirm) throw new UsageError('彻底删除需 --confirm <完整归档ID>')
        result = await deleteSpace(deps, rest[0]!, extra.confirm, author, reason)
      } else throw new UsageError('space 子命令：ls | new | archive | restore | rm')
    }
  } else {
    const stores = await openStores(options.project)
    const author = cliActor(stores)
    const reason = options.reason ?? `${command} ${sub}`
    if (command === 'repo') {
      if (sub === 'ls') { expectPositionals('repo ls', rest, 0); result = stores.config.repos ?? [] }
      else if (sub === 'add') {
        expectPositionals('repo add', rest, 2)
        const repo = repoBinding({ id: rest[0], path: rest[1], defaultBranch: options.branch ?? 'main', url: options.url, purpose: options.purpose })
        await changeConfig(stores, author, reason, `绑定仓库 ${repo.id}`, (config) => {
          if (config.repos?.some((item) => item.id === repo.id)) throw new UsageError(`仓库已绑定：${repo.id}`)
          config.repos = [...config.repos ?? [], repo]
        })
        result = repo
      } else if (sub === 'sync') {
        expectPositionals('repo sync', rest, 0, 1)
        const manager = repoManager(stores)
        const ids = rest[0] ? [rest[0]] : manager.list().map((repo) => repo.id)
        const synced = []
        for (const id of ids) synced.push({ id, ...await manager.sync(id) })
        await auditSpace(stores, author, reason, `同步仓库 ${ids.join(', ')}`)
        result = synced
      } else throw new UsageError('repo 子命令：add <id> <path> [--url URL] [--branch main] | ls | sync [id]')
    } else if (command === 'member') {
      if (sub === 'ls') { expectPositionals('member ls', rest, 0); result = stores.config.members ?? [] }
      else if (sub === 'add') {
        expectPositionals('member add', rest, 1, 2)
        const member = members([{ id: rest[0], name: options.name ?? rest[1] ?? rest[0], role: options.role ?? 'member' }])[0]!
        await changeConfig(stores, author, reason, `添加成员 ${member.id}`, (config) => {
          if (config.members?.some((item) => item.id === member.id)) throw new UsageError(`成员已存在：${member.id}`)
          config.members = [...config.members ?? [], member]
        })
        result = member
      } else throw new UsageError('member 子命令：add <id> [name] [--role member] | ls')
    } else if (command === 'skill') {
      if (sub === 'ls') expectPositionals('skill ls', rest, 0)
      else if (sub === 'add') {
        expectPositionals('skill add', rest, 1)
        const source = resolve(rest[0]!)
        const name = basename(source)
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new UsageError('技能目录名不合法')
        await readFile(join(source, 'SKILL.md'))
        const rejectLinks = async (dir: string): Promise<void> => {
          if ((await lstat(dir)).isSymbolicLink()) throw new UsageError('技能不能包含符号链接')
          const { readdir } = await import('node:fs/promises')
          if ((await lstat(dir)).isDirectory()) for (const entry of await readdir(dir)) await rejectLinks(join(dir, entry))
        }
        await rejectLinks(source)
        await mkdir(stores.paths.skills, { recursive: true })
        await cp(source, join(stores.paths.skills, name), { recursive: true, force: false, errorOnExist: true })
        await auditSpace(stores, author, reason, `添加技能 ${name}`)
      } else throw new UsageError('skill 子命令：add <dir> | ls')
      result = await listSkills(stores.paths.skills)
    } else if (command === 'workflow') {
      const store = workflowStore(stores)
      if (sub === 'ls') { expectPositionals('workflow ls', rest, 0); result = await store.list() }
      else if (sub === 'convert') { expectPositionals('workflow convert', rest, 1); result = await convertWorkflow(stores, rest[0]!, { dryRun: extra.dryRun, reason }, author) }
      else if (sub === 'show' || sub === 'lint') {
        expectPositionals(`workflow ${sub}`, rest, 1)
        const document = await store.get(rest[0]!)
        result = sub === 'show' ? document : { id: document.id, editable: document.model.editable, diagnostics: document.diagnostics }
        if (sub === 'lint' && (!document.model.editable || document.diagnostics.some((item) => item.severity === 'error'))) { printer.data(result); return 1 }
      } else if (sub === 'edit') {
        expectPositionals('workflow edit', rest, 1)
        if (!options.edits) throw new UsageError('workflow edit 需要 --edits <json文件>')
        const input = JSON.parse(await readFile(resolve(options.edits), 'utf8')) as WorkflowEditRequest | WorkflowEdit[]
        const request = Array.isArray(input) ? { edits: input, baseRev: (await store.get(rest[0]!)).rev } : input
        result = await store.edit(rest[0]!, { ...request, author, reason: options.reason ?? request.reason ?? reason })
      } else if (sub === 'revisions') { expectPositionals('workflow revisions', rest, 1); await store.get(rest[0]!); result = await store.revisions(rest[0]!) }
      else if (sub === 'rollback') { expectPositionals('workflow rollback', rest, 2); result = await store.rollback(rest[0]!, rest[1]!, author, reason) }
      else throw new UsageError('workflow 子命令：ls | lint <id> | show <id> | edit <id> --edits <json文件> | revisions <id> | rollback <id> <rev>')
      if (result && typeof result === 'object' && 'error' in result) { printer.data(result); return 1 }
    } else if (command === 'chat') {
      if (sub === 'ls') { expectPositionals('chat ls', rest, 1); result = await stores.chat.list(rest[0]!) }
      else if (sub === 'post') {
        expectPositionals('chat post', rest, 2)
        await stores.workspaces.getRequirement(rest[0]!).then((requirement) => { if (!requirement) throw new UsageError(`需求不存在：${rest[0]}`) })
        result = await stores.chat.post(rest[0]!, { author, kind: 'text', text: rest[1]!, mentions: /(^|\s)@lead\b/i.test(rest[1]!) ? ['lead'] : [] })
        if ((result as RoomMessage).mentions?.includes('lead')) await postToLead(await loadRuntime(options.project, { mock: options.mock }), rest[0]!, result as RoomMessage)
      } else throw new UsageError('chat 子命令：ls <REQ> | post <REQ> "<text>"')
    }
  }
  printer.data(result)
  return 0
}

/** 多空间服务按需加载运行时，新增或恢复空间无需重启服务。 */
export async function runSpaceServer(options: import('./serve.js').ServeOptions): Promise<void> {
  if (options.project) throw new Error('--project 与 --spaces 不能同时指定')
  const { createServer } = await import('@taktflow/server')
  const { engineDependencies, webDir } = await import('../project.js')
  const { createProjectLead, watchLeadEvents } = await import('../lead.js')
  const { createRuntimeCatalog } = await import('../catalog.js')
  const { validateRuntime } = await import('../runtime-validation.js')
  const { resumeAfterAnswer } = await import('./serve.js')
  const { access } = await import('node:fs/promises')
  const listeners = new Map<string, Set<(presence: import('@taktflow/core').LeadPresence) => void>>()
  const runtimes = new Map<string, Promise<{ context: Awaited<ReturnType<typeof loadRuntime>>; lead: Awaited<ReturnType<typeof createProjectLead>>; stop: () => Promise<void> }>>()
  const ensure = (dir: string) => {
    let pending = runtimes.get(dir)
    if (!pending) {
      pending = (async () => {
        const context = await loadRuntime(dir)
        validateRuntime(context)
        const lead = await createProjectLead(context, (id, presence) => { for (const send of listeners.get(`${dir}:${id}`) ?? []) send(presence) })
        const entry = { context, lead, stop: await watchLeadEvents(context, lead) }
        ready.set(dir, entry)
        return entry
      })()
      runtimes.set(dir, pending)
      void pending.catch(() => { if (runtimes.get(dir) === pending) runtimes.delete(dir) })
    }
    return pending
  }
  const ready = new Map<string, Awaited<ReturnType<typeof ensure>>>()
  const printer = createPrinter(options.json)
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    for (const stores of await discoverSpaces(options.spaces!)) await ensure(stores.projectDir)
    server = await createServer({ spacesDir: options.spaces, port: options.port, host: options.host,
      webDir: await access(webDir).then(() => webDir, () => undefined),
      ...createRuntimeCatalog(),
      getCommands: async (stores) => { const entry = await ensure(stores.projectDir); entry.context.stores.config = stores.config; return entry.lead.commands },
      resolveRuntime: async (stores) => { const entry = await ensure(stores.projectDir); return engineDependencies({ ...entry.context, stores }) },
      onSpaceLeadMention: options.onSpaceLeadMention ?? (async (dir, id, message) => {
        if (options.onLeadMention) await options.onLeadMention(id, message)
        else await (await ensure(dir)).lead.onMessage(id, message)
      }),
      onSpaceAnswer: async (dir, item) => { const entry = await ensure(dir); if (!await entry.lead.onAttention(item)) await resumeAfterAnswer(entry.context, item) },
      getLeadPresence: (dir, id) => ready.get(dir)?.lead.getPresence(id) ?? { state: 'idle', since: new Date().toISOString() },
      subscribeLead: (dir, id, send) => {
        const key = `${dir}:${id}`, bucket = listeners.get(key) ?? new Set()
        bucket.add(send); listeners.set(key, bucket)
        void ensure(dir).then((entry) => send(entry.lead.getPresence(id))).catch(() => {})
        return () => { bucket.delete(send); if (!bucket.size) listeners.delete(key) }
      },
    })
    if (options.json) printer.data({ url: server.url, spacesDir: options.spaces })
    else printer.text(`${printer.colors.green('✔')} takt 已启动：${server.url}  ${options.spaces}`)
    await new Promise<void>((done) => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); done() }
      process.on('SIGINT', stop); process.on('SIGTERM', stop)
    })
  } finally {
    await server?.close()
    const settled = await Promise.allSettled(runtimes.values())
    for (const entry of settled) if (entry.status === 'fulfilled') await entry.value.stop()
  }
}
