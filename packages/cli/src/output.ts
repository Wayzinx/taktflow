/** 无依赖 ANSI 着色与统一输出；--json 时 stdout 只允许一条 JSON。 */
export interface Colors {
  enabled: boolean
  green(text: string): string
  red(text: string): string
  yellow(text: string): string
  cyan(text: string): string
  dim(text: string): string
  bold(text: string): string
}

const wrap = (code: number) => (text: string) => `\u001b[${code}m${text}\u001b[0m`

export function createColors(enabled: boolean): Colors {
  const noop = (text: string) => text
  return {
    enabled,
    green: enabled ? wrap(32) : noop,
    red: enabled ? wrap(31) : noop,
    yellow: enabled ? wrap(33) : noop,
    cyan: enabled ? wrap(36) : noop,
    dim: enabled ? wrap(2) : noop,
    bold: enabled ? wrap(1) : noop,
  }
}

export interface Printer {
  json: boolean
  colors: Colors
  /** 人读输出。 */
  text(message: string): void
  /** 机器可读输出：整个进程只应调用一次。 */
  data(value: unknown): void
  /** 警告走 stderr，不污染 --json 的 stdout。 */
  warn(message: string): void
}

export function createPrinter(json: boolean): Printer {
  const colors = createColors(!json && process.stdout.isTTY === true && process.env.NO_COLOR === undefined)
  return {
    json,
    colors,
    text: (message) => process.stdout.write(`${message}\n`),
    data: (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    warn: (message) => process.stderr.write(`${message}\n`),
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
