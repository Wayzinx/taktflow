import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * 标准流程空间 QA 命令的纯解析结果。
 *
 * 只做字符串/路径解析，不访问文件系统；真实路径、符号链接和 Git 工作树校验
 * 由调用方完成。这样宿主受控自测和默认 runCases 钩子可以共享同一套绑定规则。
 */
export type WorkspaceQaCommandBinding =
  | {
      kind: 'bound'
      /** 实际执行命令：node 可执行文件 + 源脚本绝对路径（均已 shell 单引号转义）。 */
      command: string
      /** 规范化后的相对脚本路径，始终使用 / 分隔。 */
      testScript: string
      /** 源脚本绝对路径；调用方负责 realpath、符号链接和普通文件校验。 */
      sourceScript: string
    }
  | { kind: 'unbound' }
  | { kind: 'error'; error: string }

export interface WorkspaceQaIntegration {
  repo: string
  path: string
  branch: string
}

export type WorkspaceQaIntegrationSelection =
  | { kind: 'selected'; integration: WorkspaceQaIntegration }
  | { kind: 'error'; error: string }

/**
 * 校验并规范化空间根内的相对脚本路径。
 *
 * 拒绝绝对路径、反斜杠、空段、`.`、`..` 和控制字符；返回值始终使用 /，
 * 供 `join(sourceRoot, ...segments)` 和 artifact 相对路径共用。
 */
export function normalizeWorkspaceQaScript(value: string): string | undefined {
  const text = value.trim()
  if (text === '' || text.includes('\0') || text.includes('\\')) return undefined
  if (/[\u0000-\u001f\u007f]/.test(text)) return undefined
  if (isAbsolute(text)) return undefined
  const segments = text.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

/** 受控 token 化：只支持裸 token、单引号和双引号，不解释变量、命令替换或 shell 运算符。 */
function tokenize(command: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let hasToken = false
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) { quote = undefined; continue }
      if (quote === '"' && (char === '$' || char === '`' || char === '\\')) return undefined
      current += char
      hasToken = true
      continue
    }
    if (char === "'" || char === '"') { quote = char; hasToken = true; continue }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasToken) { tokens.push(current); current = ''; hasToken = false }
      continue
    }
    if ('|&;<>()$`\\\u0000'.includes(char)) return undefined
    current += char
    hasToken = true
  }
  if (quote !== undefined) return undefined
  if (hasToken) tokens.push(current)
  return tokens
}

function isNodeExecutable(token: string): boolean {
  if (token === 'node' || token === 'node.exe') return true
  if (!isAbsolute(token)) return false
  const base = token.split(/[\\/]/).at(-1)?.toLowerCase()
  return base === 'node' || base === 'node.exe'
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * 把可信的 `node <相对脚本>` QA 命令绑定到空间根源脚本的绝对路径。
 *
 * - `node`/绝对 node 可执行文件 + 单个相对脚本 → bound；
 * - 其它可执行文件（如 `npm test`）→ unbound，由调用方按原命令执行；
 * - 看起来是 Node 但带选项/额外参数、脚本越界或与 testScript 不一致 → error。
 *
 * 不猜测参数位置，也不把相对脚本留在集成 worktree 的 cwd 下执行。
 */
export function bindWorkspaceQaCommand(
  command: string,
  testScript: string | undefined,
  sourceRoot: string,
): WorkspaceQaCommandBinding {
  const tokens = tokenize(command.trim())
  if (tokens === undefined) {
    return { kind: 'error', error: '空间 QA 命令包含不支持的 shell 语法；只接受 node <相对脚本>' }
  }
  if (tokens.length === 0) return { kind: 'error', error: '空间 QA 命令为空' }
  if (!isNodeExecutable(tokens[0]!)) return { kind: 'unbound' }
  if (!isAbsolute(sourceRoot)) return { kind: 'error', error: '空间根必须是绝对路径' }
  if (tokens.length !== 2) {
    return { kind: 'error', error: '空间 QA 的 Node 命令只支持 node <相对脚本>，不接受选项或额外参数' }
  }
  const scriptToken = normalizeWorkspaceQaScript(tokens[1]!)
  if (scriptToken === undefined) {
    return { kind: 'error', error: `空间 QA 脚本必须是空间根内的相对路径：${tokens[1]}` }
  }
  if (testScript !== undefined) {
    const configured = normalizeWorkspaceQaScript(testScript)
    if (configured === undefined) {
      return { kind: 'error', error: `testScript 必须是空间根内的相对路径：${testScript}` }
    }
    if (configured !== scriptToken) {
      return { kind: 'error', error: `testScript 与实际执行脚本不一致：${configured} != ${scriptToken}` }
    }
  }
  const sourceScript = join(sourceRoot, ...scriptToken.split('/'))
  return {
    kind: 'bound',
    command: `${shellQuote(tokens[0]!)} ${shellQuote(sourceScript)}`,
    testScript: scriptToken,
    sourceScript,
  }
}

/**
 * 从 integration 节点结果中选择本次运行主仓库的集成工作树。
 *
 * 兼容引擎保存的 `result.data` 包装、`repositories[repo]` 多仓库结构和旧的
 * `tasks/integration.json` 记录；只接受本次 runId 的 integration 分支，并在
 * 给出 root 时做词法包含校验。realpath/符号链接/Git 工作树校验由调用方完成。
 */
export function selectWorkspaceQaIntegration(
  result: unknown,
  runId: string,
  expectedRepo: string,
  root?: string,
): WorkspaceQaIntegrationSelection {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { kind: 'error', error: 'integration 结果缺失或格式无效' }
  }
  const raw = result as Record<string, unknown>
  const value = raw.data !== null && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown>
    : raw
  const repo = typeof value.repo === 'string' ? value.repo : undefined
  if (repo !== undefined && repo !== expectedRepo) {
    return { kind: 'error', error: `integration 主仓库 ${repo} 与启动参数 repo=${expectedRepo} 不一致` }
  }
  let tree: Record<string, unknown> | undefined
  const repositories = value.repositories
  if (repositories !== null && typeof repositories === 'object' && !Array.isArray(repositories)) {
    const candidate = (repositories as Record<string, unknown>)[expectedRepo]
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { kind: 'error', error: `integration 结果缺少仓库 ${expectedRepo} 的工作树` }
    }
    tree = candidate as Record<string, unknown>
  }
  const pathValue = typeof tree?.path === 'string' ? tree.path : value.path
  const branchValue = typeof tree?.branch === 'string' ? tree.branch : value.branch
  if (typeof pathValue !== 'string' || pathValue.trim() === '' || !isAbsolute(pathValue)) {
    return { kind: 'error', error: 'integration 工作树路径必须是非空绝对路径' }
  }
  const expectedBranch = `takt/${runId}/integration`
  if (branchValue !== expectedBranch) {
    return { kind: 'error', error: `integration 分支 ${String(branchValue)} 不是本次运行的分支 ${expectedBranch}` }
  }
  if (root !== undefined) {
    if (!isAbsolute(root)) return { kind: 'error', error: '空间根必须是绝对路径' }
    const rel = relative(resolve(root), resolve(pathValue))
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { kind: 'error', error: `integration 工作树必须位于空间根内的独立目录：${pathValue}` }
    }
  }
  return { kind: 'selected', integration: { repo: expectedRepo, path: pathValue, branch: expectedBranch } }
}
