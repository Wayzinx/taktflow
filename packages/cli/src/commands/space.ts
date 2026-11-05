import { withCliLease } from '../lease.js'
import { cp, lstat, mkdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { listSkills, type Actor, type WorkflowEdit, type WorkflowEditRequest, type RoomMessage } from '@taktflow/core'
import { auditSpace, changeConfig, discoverSpaces, members, repoBinding, repoManager, spaceSummary, workflowStore } from '@taktflow/server'
import { expectPositionals, UsageError, type ParsedCli } from '../args.js'
import { postToLead } from '../lead.js'
import { loadRuntime, openStores } from '../project.js'
import { createPrinter } from '../output.js'
import { currentUser } from './ws.js'

export async function runSpaceCommand(cli: ParsedCli): Promise<number> {
  const writes: Record<string, string[]> = { repo: ['add', 'sync'], skill: ['add'], member: ['add'], workflow: ['edit', 'rollback'], chat: ['post'] }
  if (writes[cli.command ?? '']?.includes(cli.positionals[0]!)) {
    const stores = await openStores(cli.options.project)
    return withCliLease(stores.taktDir, () => dispatchSpaceCommand(cli), { takeover: cli.options.takeover })
  }
  return dispatchSpaceCommand(cli)
}

async function dispatchSpaceCommand(cli: ParsedCli): Promise<number> {
  const { command, positionals: args, options } = cli
  const [sub, ...rest] = args
  const printer = createPrinter(options.json)
  let result: unknown
  if (command === 'space') {
    if (sub !== 'ls') throw new UsageError('space 子命令：ls')
    expectPositionals('space ls', rest, 0, 1)
    const spaces = await discoverSpaces(options.spaces ?? rest[0] ?? options.project ?? process.cwd())
    result = await Promise.all(spaces.map(spaceSummary))
  } else {
    const stores = await openStores(options.project)
    const author: Actor = { type: 'human', id: currentUser(stores.projectDir) }
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
