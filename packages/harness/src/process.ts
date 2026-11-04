import { collectSecrets, createRedactor } from './redact.js'
export { collectSecrets, createRedactor } from './redact.js'
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { extractJsonBlock } from '@taktflow/core'
import type { HarnessRequest, HarnessResult } from '@taktflow/core'

export { extractJsonBlock } from '@taktflow/core'

export interface ProcessOptions {
  stdin?: string
  onLine?: (line: string) => void
}

export interface ProcessResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode?: number
  error?: string
  transcriptPath?: string
  spawnErrorCode?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mergeErrors(...errors: Array<string | undefined>): string | undefined {
  return [...new Set(errors.filter((error): error is string => Boolean(error)))].join('\n') || undefined
}

function fallbackErrors(text: string, failed: boolean): string | undefined {
  const keywords = text.match(/rate[ _-]?limit(?:ed|ing)?|overloaded|ACCOUNT_SIGN_IN_REQUIRED|sign\s+in|timeout/gi) ?? []
  // 成功消息里的计数、token 数或文件名不代表 HTTP 错误。
  const codes = failed
    ? text.match(/\b(?:429|503|401)\b/g) ?? []
    : [...text.matchAll(/(?:\b(?:http(?:\/[\d.]+)?|status(?:_code)?|error(?:_code)?|code)\b["'\s:=_-]*|^\s*)(429|503|401)\b/gim)]
      .map(match => match[1]!)
  return mergeErrors(...keywords, ...codes)
}

export async function runProcess(
  command: string,
  args: string[],
  req: HarnessRequest,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const result: ProcessResult = { ok: false, stdout: '', stderr: '' }
  const redact = createRedactor(collectSecrets(req))
  // 原始输出仅在内存拼接，结束时整体脱敏，兼容分块与无换行输出。
  let rawStdout = ''
  let rawStderr = ''
  if (req.signal?.aborted) return { ...result, error: 'Process cancelled before spawn' }

  let transcript: Awaited<ReturnType<typeof open>> | undefined
  const transcriptPath = req.env?.TAKT_TRANSCRIPT
  if (transcriptPath) {
    try {
      await mkdir(dirname(transcriptPath), { recursive: true })
      transcript = await open(transcriptPath, 'a')
      result.transcriptPath = transcriptPath
    } catch (error) {
      return { ...result, error: redact(`Transcript open failed: ${errorText(error)}`) }
    }
  }

  let writes = Promise.resolve()
  let transcriptFailed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const addError = (message: string) => { result.error = mergeErrors(result.error, redact(message)) }

  try {
    if (req.signal?.aborted) {
      addError('Process cancelled before spawn')
    } else {
      await new Promise<void>(resolve => {
        const child = spawn(command, args, {
          cwd: req.cwd,
          env: { ...process.env, ...req.env },
          stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          // 独立进程组允许回收继承了输出管道的后代，避免 close 永远不触发。
          detached: process.platform !== 'win32',
        })
        let closed = false
        let stopping = false
        const kill = (signal: NodeJS.Signals) => {
          if (!child.pid || closed) return
          try {
            if (process.platform === 'win32') child.kill(signal)
            else process.kill(-child.pid, signal)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') addError(`Process ${signal} failed: ${errorText(error)}`)
          }
        }
        const stop = (message: string) => {
          addError(message)
          if (closed || stopping) return
          stopping = true
          kill('SIGTERM')
          escalation = setTimeout(() => kill('SIGKILL'), 5_000)
        }

        child.on('error', error => {
          result.spawnErrorCode = (error as NodeJS.ErrnoException).code
          stop(`Process error: ${errorText(error)}`)
        })
        child.stdout!.setEncoding('utf8')
        child.stderr!.setEncoding('utf8')
        child.stdout!.on('data', (chunk: string) => { rawStdout += chunk })
        child.stderr!.on('data', (chunk: string) => { rawStderr += chunk })
        child.stdout!.on('error', error => stop(`Stdout failed: ${errorText(error)}`))
        child.stderr!.on('error', error => stop(`Stderr failed: ${errorText(error)}`))
        const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
        let callbackFailed = false
        lines.on('line', line => {
          // 行结束时整行可见，跨数据块的密钥在这里能被完整匹配。
          const safe = redact(line)
          if (transcript) {
            writes = writes.then(async () => {
              if (!transcriptFailed) await transcript!.appendFile(`${safe}\n`, 'utf8')
            }).catch(error => {
              transcriptFailed = true
              stop(`Transcript write failed: ${errorText(error)}`)
            })
          }
          if (callbackFailed) return
          try {
            options.onLine?.(safe)
          } catch (error) {
            callbackFailed = true
            stop(`onLine failed: ${errorText(error)}`)
          }
        })
        lines.on('error', error => stop(`Readline failed: ${errorText(error)}`))
        child.on('close', (code, signal) => {
          closed = true
          lines.close()
          if (code !== null) result.exitCode = code
          if (code !== 0) addError(signal ? `Process terminated by ${signal}` : `Process exited with code ${code}`)
          clearTimeout(timeout)
          clearTimeout(escalation)
          resolve()
        })
        onAbort = () => stop('Process cancelled')
        req.signal?.addEventListener('abort', onAbort, { once: true })
        timeout = setTimeout(() => stop(`Process timeout after ${req.timeoutMs ?? 30 * 60_000}ms`), req.timeoutMs ?? 30 * 60_000)
        if (req.signal?.aborted) onAbort()
        if (child.stdin) {
          child.stdin.on('error', error => stop(`Stdin failed: ${errorText(error)}`))
          child.stdin.end(options.stdin)
        }
      })
    }
  } catch (error) {
    addError(`Process setup failed: ${errorText(error)}`)
  } finally {
    clearTimeout(timeout)
    clearTimeout(escalation)
    if (onAbort) req.signal?.removeEventListener('abort', onAbort)
    await writes
    try {
      await transcript?.close()
    } catch (error) {
      addError(`Transcript close failed: ${errorText(error)}`)
    }
  }

  result.stdout = redact(rawStdout)
  result.stderr = redact(rawStderr)
  addError(fallbackErrors(`${result.stdout}\n${result.stderr}`, result.exitCode !== 0 || Boolean(result.error)) ?? '')
  if (result.exitCode !== 0 || result.error) addError(result.stderr.trim())
  if (result.error !== undefined) result.error = redact(result.error)
  result.ok = result.exitCode === 0 && !result.error
  return result
}

export function finalizeResult(req: HarnessRequest, parsed: HarnessResult, proc: ProcessResult): HarnessResult {
  const redact = createRedactor(collectSecrets(req))
  const { structured: _structured, ...rest } = parsed
  const result: HarnessResult = {
    ...rest,
    ok: parsed.ok && proc.ok,
    finalText: redact(parsed.finalText),
    ...(parsed.sessionId === undefined ? {} : { sessionId: redact(parsed.sessionId) }),
    error: mergeErrors(parsed.error === undefined ? undefined : redact(parsed.error), proc.error === undefined ? undefined : redact(proc.error)),
    transcriptPath: proc.transcriptPath ?? parsed.transcriptPath,
    exitCode: proc.exitCode ?? parsed.exitCode,
  }
  if (req.resultSchema !== undefined) {
    result.structured = extractJsonBlock(result.finalText)
  }
  return result
}
