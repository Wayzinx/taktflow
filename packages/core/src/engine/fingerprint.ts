import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FailureRecord, NodeState } from '../types.js'
import { globsOverlap } from '../util/glob.js'
import { sha256 } from '../util/hash.js'

export class FailureError extends Error {
  constructor(message: string, readonly code: string, readonly target?: string, readonly recorded = false) { super(message) }
}

export async function inputIdentity(ns: Pick<NodeState, 'inputs' | 'worktree'>): Promise<string> {
  let head = ''
  if (ns.worktree) head = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: ns.worktree.path })).stdout.trim()
  return sha256(JSON.stringify([(ns.inputs ?? []).map((ref) => `${ref.path}@${ref.version ?? 'latest'}`).sort(), head])).slice(0, 16)
}

export async function recordFailure(ns: NodeState, code: string, target: string | undefined, at: string, message?: string, source = ns): Promise<FailureRecord> {
  const inputs = await inputIdentity(source)
  const fingerprint = sha256(`${ns.id}:${code}:${target ?? ''}:${inputs}`).slice(0, 16)
  const failures = ns.failures ??= []
  let failure = failures.find((item) => item.fingerprint === fingerprint)
  if (!failure) {
    failure = { fingerprint, code, target, inputs, count: 0, firstAt: at, lastAt: at }
    failures.push(failure)
  }
  failure.count++
  failure.lastAt = at
  failure.message = message
  return failure
}

export function failureCode(error: unknown): string {
  if (error instanceof FailureError) return error.code
  const text = error instanceof Error ? error.message : String(error)
  if (/完成标准未满足/.test(text)) return 'completion.unmet'
  if (/timeout|timed out|超时/i.test(text) || (error instanceof Error && error.name === 'TimeoutError')) return 'timeout'
  if (/写权限|越界|守卫/.test(text)) return 'guard'
  const exit = /(?:退出码|exit(?: code)?)\s*(-?\d+)/i.exec(text)
  return exit ? `exit:${exit[1]}` : 'error'
}

// 无法静态证明不相交时保守串行（包含部分文件名前缀，如 src/foo*.ts）。
export function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => globsOverlap(a, b)))
}
