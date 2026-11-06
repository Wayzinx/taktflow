import { parseArgs } from 'node:util'

/** 参数错误：统一由 CLI 入口转成一行提示，不打印堆栈。 */
export class UsageError extends Error {}

export interface CliOptions {
  project?: string
  json: boolean
  help: boolean
  name?: string
  link?: string
  kind?: string
  reason?: string
  version?: string
  arg: string[]
  harness?: string
  mock?: string
  autoApprove: boolean
  approve: boolean
  reject: boolean
  answer?: string
  choice?: string
  noResume: boolean
  takeover: boolean
  req?: string
  run?: string
  intent?: string
  port?: string
  host?: string
  spaces?: string
  layout?: string
  edits?: string
  branch?: string
  url?: string
  purpose?: string
  role?: string
}

export interface ParsedCli {
  command?: string
  positionals: string[]
  options: CliOptions
}

export const HELP = `用法：takt <命令> [选项]

命令：
  init [dir] [--name <n>] [--layout space|legacy]                       初始化项目并复制默认角色 / 流水线
  req new "<title>" [--link <url>]              创建需求
  req ls                                        列出需求
  ws put <REQ> <path> <file|-> [--kind input] [--reason <r>]
                                                写产物（author 为当前用户）
  ws get <REQ> <path> [--version n]             读产物
  ws ls <REQ>                                   列出产物
  ws log <REQ> <path>                           产物版本历史
  run <workflowId> --req <REQ> [--arg k=v]... [--harness <id>] [--mock <file>] [--auto-approve] [--takeover]
  resume <runId> [--auto-approve] [--harness <id>] [--mock <file>] [--takeover]
  answer <requestId> (--approve | --reject | --answer "<text>" | --choice <c>) [--no-resume] [--takeover]
  cancel <runId> [--takeover]                  取消运行并结束在途节点
  status [--req <REQ>]
  trace <REQ>
  audit verify <runId>
  quality sync [--run <runId>] | quality repair [--reason <说明>] | quality verify
  quality defects [--req <REQ>] [--json]
  kb query "<text>" [--intent <i>]
  harness ls                                    列出 harness、能力和可用性
  models ls                                     列出模型与密钥配置状态
  doctor                                        检查配置、插件和运行环境
  space ls [dir] [--spaces <dir>]
  repo add <id> <path> [--url <url>] [--branch main] | repo ls | repo sync [id]
  skill ls | skill add <dir>
  member ls | member add <id> [--name <n>] [--role member]
  workflow ls | workflow lint <id> | workflow show <id>
  workflow edit <id> --edits <json文件> | workflow revisions <id> | workflow rollback <id> <rev>
  chat ls <REQ> | chat post <REQ> "<text>"
  serve [--spaces <dir>] [--port 4870] [--host 127.0.0.1]

全局选项：
  --project <dir>   项目目录（默认 cwd，并向上查找 takt.config.json）
  --json            机器可读输出
  --takeover        显式接管已失效的空间租约（写命令）
  --help            显示帮助`

const OPTIONS = {
  project: { type: 'string' },
  spaces: { type: 'string' },
  layout: { type: 'string' },
  edits: { type: 'string' },
  branch: { type: 'string' },
  url: { type: 'string' },
  purpose: { type: 'string' },
  role: { type: 'string' },

  json: { type: 'boolean' },
  help: { type: 'boolean' },
  name: { type: 'string' },
  link: { type: 'string' },
  kind: { type: 'string' },
  reason: { type: 'string' },
  version: { type: 'string' },
  arg: { type: 'string', multiple: true },
  harness: { type: 'string' },
  mock: { type: 'string' },
  'auto-approve': { type: 'boolean' },
  approve: { type: 'boolean' },
  reject: { type: 'boolean' },
  answer: { type: 'string' },
  choice: { type: 'string' },
  'no-resume': { type: 'boolean' },
  takeover: { type: 'boolean' },
  req: { type: 'string' },
  run: { type: 'string' },
  intent: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
} as const

export function parseCliArgs(argv: string[]): ParsedCli {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const values = parsed.values
  const options: CliOptions = {
    json: values.json === true,
    help: values.help === true,
    arg: values.arg ?? [],
    autoApprove: values['auto-approve'] === true,
    approve: values.approve === true,
    reject: values.reject === true,
    noResume: values['no-resume'] === true,
    takeover: values.takeover === true,
  }
  for (const key of ['project', 'name', 'link', 'kind', 'reason', 'version', 'harness', 'mock', 'answer', 'choice', 'req', 'run', 'intent', 'port', 'host', 'spaces', 'layout', 'edits', 'branch', 'url', 'purpose', 'role'] as const) {
    const value = values[key]
    if (value !== undefined) options[key] = value
  }
  const [command, ...positionals] = parsed.positionals
  return command === undefined ? { positionals, options } : { command, positionals, options }
}

/** 位置参数个数校验：少给 / 多给都报同一句。 */
export function expectPositionals(command: string, positionals: string[], min: number, max = min): string[] {
  if (positionals.length < min) throw new UsageError(`${command} 缺少参数（需要 ${min} 个，实际 ${positionals.length} 个）`)
  if (positionals.length > max) throw new UsageError(`${command} 参数过多（最多 ${max} 个，实际 ${positionals.length} 个）：${positionals.slice(max).join(' ')}`)
  return positionals
}

export function parsePositiveInt(value: string, name: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${name} 必须是正整数：${value}`)
  }
  return Number(value)
}

/** `--arg k=v` 可重复；缺少 key 或等号视为参数错误，允许空 value，重复 key 后者覆盖。 */
export function parseRunArgs(values: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const value of values) {
    const index = value.indexOf('=')
    if (index <= 0) throw new UsageError(`--arg 必须是 k=v 形式：${value}`)
    args[value.slice(0, index)] = value.slice(index + 1)
  }
  return args
}

export interface AnswerInput {
  decision?: string
  answer?: string
}

/** answer 的四个取值互斥，且必须选一个。 */
export function parseAnswerOptions(options: Pick<CliOptions, 'approve' | 'reject' | 'answer' | 'choice'>): AnswerInput {
  const selected = [
    options.approve ? '--approve' : undefined,
    options.reject ? '--reject' : undefined,
    options.answer !== undefined ? '--answer' : undefined,
    options.choice !== undefined ? '--choice' : undefined,
  ].filter((value): value is string => value !== undefined)
  if (selected.length === 0) throw new UsageError('answer 需要 --approve、--reject、--answer 或 --choice 之一')
  if (selected.length > 1) throw new UsageError(`answer 的选项互斥：${selected.join(', ')}`)
  if (options.approve) return { decision: 'approve' }
  if (options.reject) return { decision: 'reject' }
  if (options.choice !== undefined) return { decision: 'choice', answer: options.choice }
  return { answer: options.answer }
}
