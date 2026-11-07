import { join, resolve } from 'node:path'
import { applyEdits } from '@taktflow/workflow-source'
import { StewardAgent, buildDigest, refreshRisks, stewardId, stewardUserId, stewardActor, openProject, stewardUndoCommands, requireRole, type StewardDeps, type CommandRegistry, type Proposal } from '@taktflow/core'
import { discoverSpaces, spaceId, spaceSummary, workflowStore, projectCommands, createServerCommandRegistry, auditSpace } from '@taktflow/server'
import { type ParsedCli, expectPositionals, UsageError } from '../args.js'
import { cliActor } from '../actor.js'
import { createPrinter } from '../output.js'

export interface StewardCli extends Omit<ParsedCli, 'options'> {
  options: ParsedCli['options'] & { thread?: string; space?: string; hash?: string }
  stewardDeps?: StewardDeps
  serverCommands?: CommandRegistry
}
export async function runStewardCommand(cli: StewardCli): Promise<number> {
  const [sub, ...args] = cli.positionals, options = cli.options
  const stores = options.spaces ? await discoverSpaces(options.spaces) : [await openProject(options.project ?? process.cwd())]
  const by = cliActor(stores[0]!)
  if (by.type !== 'human') throw new UsageError('管家命令需要用户身份')
  const deps: StewardDeps = cli.stewardDeps ?? {
    dataDir: (id) => options.spaces ? join(resolve(options.spaces), '.steward', stewardUserId(id)) : join(stores[0]!.taktDir, 'steward', stewardUserId(id)),
    spaces: async () => Promise.all((await Promise.all(stores.map((s) => openProject(s.projectDir)))).filter((s) => { try { requireRole(s, by, 'viewer', '查询空间'); return true } catch { return false } }).map(spaceSummary)),
    open: async (id) => {
      const found = stores.find((s) => spaceId(s) === stewardId(id))
      if (!found) throw new UsageError('空间不存在，请检查 --space')
      const fresh = await openProject(found.projectDir)
      requireRole(fresh, by, 'viewer', '管家查询')
      return { id, name: fresh.config.project.name, dir: fresh.projectDir, stores: fresh, commands: stewardUndoCommands(fresh, projectCommands(fresh), (actor, reason, message) => auditSpace(fresh, actor, reason, message)), workflows: workflowStore(fresh),
        postToLead: async (req, text) => (await fresh.chat.post(req, { author: stewardActor, kind: 'text', text, mentions: ['lead'] })).id,
        onChat: (req, listener) => fresh.chat.subscribe(req, listener),
      }
    }, applyWorkflowEdits: applyEdits, serverCommands: cli.serverCommands ?? createServerCommandRegistry({ spacesDir: options.spaces, projectDir: options.project }),
  }
  const agent = new StewardAgent(deps, by.id), printer = createPrinter(options.json)
  const output = (value: unknown) => options.json ? printer.data(value) : printer.text(JSON.stringify(value, null, 2))
  try {
    if (sub === 'ask') {
      expectPositionals('steward ask', args, 1)
      const message = await agent.ask({ text: args[0]!, context: options.space ? [{ type: 'space', id: options.space, spaceId: options.space }] : options.spaces ? [] : [{ type: 'space', id: spaceId(stores[0]!), spaceId: spaceId(stores[0]!) }] }, options.thread)
      if (options.json) output(message)
      else { printer.text(message.text || message.error || '没有回复'); for (const [i, citation] of (message.citations ?? []).entries()) printer.text(`[${i + 1}] ${citation.label} ${citation.href}`); for (const id of message.proposalIds ?? []) output(await agent.store.proposal(id)) }
      return message.status === 'error' ? 1 : 0
    }
    if (sub === 'risks') { expectPositionals('steward risks', args, 0); output((await refreshRisks(deps, agent.store)).filter((r) => !options.space || r.spaceId === options.space)) }
    else if (sub === 'digest') { expectPositionals('steward digest', args, 0); output(await buildDigest(deps, agent.store)) }
    else if (sub === 'proposals') { expectPositionals('steward proposals', args, 0); output(await agent.store.list<Proposal>('proposals')) }
    else if (sub === 'approve' || sub === 'reject' || sub === 'undo') {
      expectPositionals(`steward ${sub}`, args, 1)
      const proposal = await agent.store.proposal(args[0]!)
      const result = sub === 'approve' ? await agent.proposals.approve(proposal.id, { hash: options.hash ?? proposal.hash, reason: options.reason }, by) : await agent.proposals[sub](proposal.id, by, options.reason)
      output(result)
      if (result.status === 'failed') return 1
    } else throw new UsageError('steward 子命令：ask | risks | digest | proposals | approve | reject | undo')
    return 0
  } finally { agent.close() }
}
