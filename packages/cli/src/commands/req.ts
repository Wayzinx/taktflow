import { readFile } from 'node:fs/promises'
import type { CliOptions, ParsedCli } from '../args.js'
import { expectPositionals, UsageError } from '../args.js'
import { projectCommands, deleteRequirement } from '@taktflow/server'
import type { ProjectStores, RequirementCreateResponse } from '@taktflow/core'
import { latestRun, requirementState } from '../requirement-state.js'
import { createPrinter } from '../output.js'
import { loadRuntime, openStores } from '../project.js'
import { cliActor } from '../actor.js'
import { createProjectLead } from '../lead.js'

export interface CrudCliOptions {
  descFile?: string; start?: boolean; due?: string; owner?: string; template?: string; from?: string; parts?: string; color?: string; confirm?: string; dryRun?: boolean
}
function requirementCommands(stores: ProjectStores, mock?: string) {
  return projectCommands(stores, { startRun: async (input, context) => {
    const lead = await createProjectLead(await loadRuntime(stores.projectDir, { mock }))
    const response = await lead.commands.run('run.start', Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), context)
    await lead.drain()
    if (!response.ok) throw new Error(response.message)
    return response.result
  } })
}
export async function runReqCreateCommand(cli: ParsedCli): Promise<number> {
  const stores = await openStores(cli.options.project)
  let input: unknown
  try { input = JSON.parse(cli.options.input ?? '{}') } catch { throw new UsageError('--input 必须是 JSON 对象') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('--input 必须是 JSON 对象')
  const result = await requirementCommands(stores, cli.options.mock).run('requirement.create', input as Record<string, unknown>, { actor: cliActor(stores), reason: cli.options.reason })
  createPrinter(cli.options.json).data(result)
  return result.ok ? 0 : 1
}
export async function runReqNew(project: string | undefined, title: string, options: Partial<CliOptions> & CrudCliOptions & { json: boolean }): Promise<void> {
  if (options.desc !== undefined && options.descFile !== undefined) throw new UsageError('--desc 与 --desc-file 不能同时使用')
  const stores = await openStores(project)
  const commands = requirementCommands(stores, options.mock)
  const description = options.descFile ? await readFile(options.descFile, 'utf8') : options.desc
  const input = Object.fromEntries(Object.entries({ title, description, workflowId: options.workflow, start: options.start ?? false, dueAt: options.due,
    owner: options.owner, links: options.link ? [{ type: linkType(options.link), url: options.link }] : [] }).filter(([, value]) => value !== undefined))
  const response = await commands.run('requirement.create', input, { actor: cliActor(stores), reason: options.reason ?? 'CLI 创建需求' })
  if (!response.ok) throw new Error(response.message)
  const result = response.result as RequirementCreateResponse
  const printer = createPrinter(options.json)
  if (options.json) printer.data({ ...result.requirement, route: result.route, runId: result.runId, startError: result.startError })
  else {
    printer.text(`${printer.colors.green('✔')} 已创建 ${printer.colors.bold(result.requirement.id)}  ${result.requirement.title}`)
    if (result.startError) printer.warn(result.startError)
    if (result.runId) printer.text(`运行：${result.runId}`)
  }
}
export async function runReqEdit(cli: ParsedCli): Promise<number> {
  const options = cli.options as CliOptions & CrudCliOptions
  const [sub, id] = cli.positionals
  expectPositionals(`req ${sub}`, cli.positionals.slice(1), 1)
  const stores = await openStores(options.project), author = cliActor(stores), reason = options.reason ?? `CLI req ${sub}`
  if (sub === 'rm') { createPrinter(options.json).data(await deleteRequirement(stores, id!, author, reason)); return 0 }
  if (!['edit', 'archive', 'restore'].includes(sub!)) throw new UsageError('req 子命令：new | ls | edit | archive | restore | rm')
  const input = Object.fromEntries(Object.entries({ requirementId: id, ...(sub === 'edit' ? { title: options.title, description: options.desc, dueAt: options.due === 'null' ? null : options.due, owner: options.owner } : {}) }).filter(([, value]) => value !== undefined))
  const result = await projectCommands(stores).run(`requirement.${sub === 'edit' ? 'update' : sub}`, input, { actor: author, reason })
  createPrinter(options.json).data(result)
  return result.ok ? 0 : 1
}
export async function runReqList(project: string | undefined, json: boolean): Promise<void> {
  const stores = await openStores(project)
  const runs = await stores.runs.list()
  const requirements = await Promise.all((await stores.workspaces.listRequirements()).filter((item) => item.status !== 'archived').map((item) => requirementState(stores, item, latestRun(runs, item.id))))
  const printer = createPrinter(json)
  if (json) { printer.data(requirements); return }
  if (!requirements.length) { printer.text(printer.colors.dim('还没有需求。用 takt req new "<title>" 创建。')); return }
  for (const requirement of requirements) {
    const stage = requirement.stage === undefined ? '' : printer.colors.dim(` [${requirement.stage}]`)
    printer.text(`${printer.colors.cyan(requirement.id)}  ${requirement.status.padEnd(9)} ${requirement.title}${stage}`)
  }
}
function linkType(url: string): string {
  if (/github\.com/i.test(url)) return 'github'
  if (/meego|jira/i.test(url)) return 'meego'
  if (/feishu|larksuite/i.test(url)) return 'feishu'
  return 'url'
}
