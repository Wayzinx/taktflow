import { join } from 'node:path'
import { StewardAgent, buildDigest, refreshRisks, openProject, type StewardDeps, type CommandRegistry, type Proposal } from '@taktflow/core'
import { discoverSpaces, spaceId, projectCommands } from '@taktflow/server'
import { type ParsedCli, expectPositionals, UsageError } from '../args.js'
import { currentUser } from './ws.js'
import { cliActor } from '../actor.js'
import { createPrinter } from '../output.js'

export interface StewardCli extends Omit<ParsedCli, 'options'> {
  options: ParsedCli['options'] & { thread?: string; space?: string; hash?: string; confirm?: string }
  stewardDeps?: StewardDeps
  serverCommands?: CommandRegistry
}
export async function runStewardCommand(cli: StewardCli): Promise<number> {
  const [sub, ...args] = cli.positionals, options = cli.options
  const stores = options.spaces ? await discoverSpaces(options.spaces) : [await openProject(options.project ?? process.cwd())]
  const by = stores[0] ? cliActor(stores[0]) : { type: 'human' as const, id: currentUser(options.spaces) }
  if (by.type !== 'human') throw new UsageError('管家命令需要用户身份')
  const { attachKnowledge, createStewardDeps, stewardModel } = await import('@taktflow/server')
  const { knowledgeRisks } = await import('@taktflow/knowledge')
  const { loadRuntime } = await import('../project.js')
  const { createProjectLead } = await import('../lead.js')
  const leads = new Map<string, Promise<Awaited<ReturnType<typeof createProjectLead>>>>()
  const lead = (dir: string) => {
    let result = leads.get(dir)
    if (!result) { result = loadRuntime(dir).then(context => createProjectLead(context)); leads.set(dir, result) }
    return result
  }
  const deps: StewardDeps = cli.stewardDeps ?? createStewardDeps({ spacesDir: options.spaces, projectDir: options.project ?? stores[0]?.projectDir,
    serverCommands: cli.serverCommands, prepareStores: async stores => attachKnowledge(stores, options.spaces),
    commands: stores => {
      const invoke = async (id: string, input: Record<string, unknown>, context: import('@taktflow/core').CommandContext) => {
        const result = await (await lead(stores.projectDir)).commands.run(id, input, context)
        if (!result.ok) throw new Error(result.message)
        return result.result
      }
      return projectCommands(stores, {
        startRun: (input, context) => invoke('run.start', input, context),
        resumeRun: (input, context) => invoke('run.resume', input, context),
        cancelRun: (input, context) => invoke('run.cancel', input, context),
        dispatchTask: (input, context) => invoke('task.dispatch', input, context),
      })
    },
    onLeadMention: async (dir, req, message) => { await (await lead(dir)).onMessage(req, message) },
    steward: { extraRisks: knowledgeRisks },
  }, by.id)
  const agent = new StewardAgent(deps, by.id), printer = createPrinter(options.json)
  const output = (value: unknown) => options.json ? printer.data(value) : printer.text(JSON.stringify(value, null, 2))
  try {
    if (!cli.stewardDeps) deps.chat = stewardModel(stores, await agent.store.prefs()).chat
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
      const result = sub === 'approve' ? await agent.proposals.approve(proposal.id, { hash: options.hash ?? proposal.hash, confirm: options.confirm, reason: options.reason }, by) : await agent.proposals[sub](proposal.id, by, options.reason)
      output(result)
      if (result.status === 'failed') return 1
    } else throw new UsageError('steward 子命令：ask | risks | digest | proposals | approve | reject | undo')
    return 0
  } finally { agent.close(); for (const pending of leads.values()) await (await pending).drain() }
}
