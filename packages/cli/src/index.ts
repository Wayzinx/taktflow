#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseCliArgs, expectPositionals, parsePositiveInt, HELP, UsageError, type ParsedCli } from './args.js'
import { createPrinter } from './output.js'
import { runInit } from './commands/init.js'
import { runReqList, runReqNew } from './commands/req.js'
import { runWsGet, runWsList, runWsLog, runWsPut } from './commands/ws.js'
import { runWorkflow, resumeWorkflow } from './commands/run.js'
import { runAnswer } from './commands/answer.js'
import { runStatus, runTrace } from './commands/status.js'
import { runAuditVerify } from './commands/audit.js'
import { runKbQuery } from './commands/kb.js'
import { runSpaceCommand } from './commands/space.js'
import { runServe } from './commands/serve.js'
import { runCatalog, runDoctor } from './commands/catalog.js'

export { knowledgeFromConfig } from './knowledge.js'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let cli: ParsedCli
  try {
    cli = parseCliArgs(argv)
  } catch (error) {
    return fail(error, argv.includes('--json'))
  }
  if (cli.options.help || cli.command === undefined) {
    process.stdout.write(`${HELP}\n`)
    return cli.command === undefined && !cli.options.help ? 1 : 0
  }
  try {
    return await dispatch(cli)
  } catch (error) {
    return fail(error, cli.options.json)
  }
}

async function dispatch(cli: ParsedCli): Promise<number> {
  const { command, positionals: args, options } = cli
  switch (command) {
    case 'space':
    case 'repo':
    case 'skill':
    case 'member':
    case 'workflow':
    case 'chat':
      return runSpaceCommand(cli)
    case 'doctor':
      expectPositionals('doctor', args, 0, 0)
      return runDoctor(options.project, options.json)
    case 'harness':
    case 'models':
      if (args[0] !== 'ls') throw new UsageError(`${command} 子命令：ls`)
      expectPositionals(`${command} ls`, args.slice(1), 0, 0)
      await runCatalog(options.project, command, options.json)
      return 0
    case 'init':
      expectPositionals('init', args, 0, 1)
      await runInit(options.project, { name: options.name, json: options.json, layout: options.layout }, args[0])
      return 0
    case 'req': {
      const sub = args[0]
      if (sub === 'new') {
        expectPositionals('req new', args.slice(1), 1, 1)
        await runReqNew(options.project, args[1]!, options)
        return 0
      }
      if (sub === 'ls') {
        expectPositionals('req ls', args.slice(1), 0, 0)
        await runReqList(options.project, options.json)
        return 0
      }
      throw new UsageError('req 子命令：new | ls')
    }
    case 'ws': {
      const sub = args[0]
      if (sub === 'put') {
        const [, ...rest] = args
        expectPositionals('ws put', rest, 3, 3)
        await runWsPut(options.project, rest[0]!, rest[1]!, rest[2]!, options)
        return 0
      }
      if (sub === 'get') {
        const [, ...rest] = args
        expectPositionals('ws get', rest, 2, 2)
        const version = options.version === undefined ? undefined : parsePositiveInt(options.version, '--version')
        await runWsGet(options.project, rest[0]!, rest[1]!, { version, json: options.json })
        return 0
      }
      if (sub === 'ls') {
        const [, ...rest] = args
        expectPositionals('ws ls', rest, 1, 1)
        await runWsList(options.project, rest[0]!, options.json)
        return 0
      }
      if (sub === 'log') {
        const [, ...rest] = args
        expectPositionals('ws log', rest, 2, 2)
        await runWsLog(options.project, rest[0]!, rest[1]!, options.json)
        return 0
      }
      throw new UsageError('ws 子命令：put | get | ls | log')
    }
    case 'run':
      expectPositionals('run', args, 1, 1)
      return runWorkflow(cli)
    case 'resume':
      expectPositionals('resume', args, 1, 1)
      return resumeWorkflow(cli)
    case 'answer':
      expectPositionals('answer', args, 1, 1)
      return runAnswer(cli)
    case 'status':
      expectPositionals('status', args, 0, 0)
      await runStatus(options.project, options.req, options.json)
      return 0
    case 'trace':
      expectPositionals('trace', args, 1, 1)
      await runTrace(options.project, args[0]!, options.json)
      return 0
    case 'audit': {
      if (args[0] !== 'verify') throw new UsageError('audit 子命令：verify')
      expectPositionals('audit verify', args.slice(1), 1, 1)
      return await runAuditVerify(options.project, args[1]!, options.json) ? 0 : 1
    }
    case 'kb': {
      if (args[0] !== 'query') throw new UsageError('kb 子命令：query')
      expectPositionals('kb query', args.slice(1), 1, 1)
      await runKbQuery(options.project, args[1]!, options.intent, options.json)
      return 0
    }
    case 'serve': {
      expectPositionals('serve', args, 0, 0)
      const port = options.port === undefined ? undefined : parsePositiveInt(options.port, '--port')
      if (port !== undefined && port > 65535) throw new UsageError('--port 必须在 1–65535 之间')
      await runServe({ project: options.project, spaces: options.spaces, port, host: options.host, json: options.json })
      return 0
    }
    default:
      throw new UsageError(`未知命令：${command}\n\n${HELP}`)
  }
}

function fail(error: unknown, json: boolean): number {
  const message = error instanceof Error ? error.message : String(error)
  const printer = createPrinter(json)
  if (json) printer.data({ error: message })
  else printer.warn(`${printer.colors.red('✘')} ${message}`)
  return error instanceof UsageError ? 2 : 1
}

// 只有直接执行入口时才跑 CLI；测试 import 本模块不能触发。
// 安装后的 bin 是符号链接：argv[1] 与 import.meta.url 必须解析真实路径再比。
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
const isEntry = invokedDirectly()
if (isEntry) {
  main().then((code) => { process.exitCode = code }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
