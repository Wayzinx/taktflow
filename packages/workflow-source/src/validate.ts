import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Readable } from 'node:stream'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowDiagnostic, WorkflowSnapshot } from '@taktflow/core'
import { parseWorkflowSource } from './parse.js'

export interface WorkflowValidation { snapshot?: WorkflowSnapshot; diagnostics: WorkflowDiagnostic[] }

export async function validateWorkflowSource(file: string): Promise<WorkflowValidation> {
  file = resolve(file)
  const source = await readFile(file, 'utf8')
  const parsed = parseWorkflowSource(source, file)
  // 子集以外的合法 TS 仍可运行；语法错误在加载前由编译器诊断给出准确位置。
  const syntax = (parsed.spans.file as typeof parsed.spans.file & { parseDiagnostics: readonly unknown[] }).parseDiagnostics
  if (syntax.length) return { diagnostics: parsed.diagnostics }
  const compiled = new URL('./validate-runner.js', import.meta.url)
  const runner = fileURLToPath(existsSync(compiled) ? compiled : new URL('./validate-runner.ts', import.meta.url))
  const loader = createRequire(import.meta.url).resolve('tsx')
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ['--import', loader, runner, file], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    })
    let response = ''
    let stderr = ''
    let timedOut = false
    let oversized = false
    const limit = 8 * 1024 * 1024
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15_000)
    ;(child.stdio[3] as Readable).setEncoding('utf8').on('data', (data: string) => {
      response += data
      if (response.length > limit) { oversized = true; child.kill('SIGKILL') }
    })
    child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16_384) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResult({ diagnostics: [{ severity: 'error', message: `无法启动校验子进程：${error.message}` }] })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let message: string
      let stack = ''
      if (timedOut) message = 'workflow 加载超时（15 秒）'
      else if (oversized) message = 'workflow 快照超过 8 MiB 限制'
      else {
        try {
          const result = JSON.parse(response) as WorkflowValidation & { message?: string; stack?: string }
          if (code === 0 && result.snapshot) { resolveResult({ snapshot: result.snapshot, diagnostics: [] }); return }
          message = result.message ?? `workflow 校验进程退出（${code}）`
          stack = result.stack ?? ''
        } catch {
          message = `workflow 校验进程未返回快照（${code}）：${stderr.trim()}`
        }
      }
      const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const position = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack + stderr)
      resolveResult({ diagnostics: [{ severity: 'error', message,
        ...(position ? { line: Number(position[1]), column: Number(position[2]) } : {}),
      }] })
    })
  })
}
