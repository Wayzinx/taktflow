import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { HarnessRequest } from '@taktflow/core'
import { object, RpcError, type ObjectValue } from './protocol.js'

interface Pending { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }

export class AcpClient {
  private readonly child: ChildProcess
  private readonly lines: Interface
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Set<Promise<void>>()
  private nextId = 0
  private failure?: Error
  private closed = false
  private readonly ended: Promise<void>

  constructor(command: string[], req: HarnessRequest, private readonly redact: (text: string) => string,
    private readonly onNotification: (method: string, params: ObjectValue) => void,
    private readonly onRequest: (method: string, params: ObjectValue) => Promise<unknown>) {
    this.child = spawn(command[0]!, command.slice(1), {
      cwd: req.cwd, env: { ...process.env, ...req.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    this.ended = new Promise(resolve => this.child.once('close', () => { this.closed = true; resolve() }))
    this.child.on('error', () => this.fail(new Error('ACP 进程启动失败，请检查命令路径、安装和执行权限')))
    this.child.on('close', (code, signal) => this.fail(new Error(`ACP 进程提前退出（${signal ?? code}），请检查 agent 登录和运行环境`)))
    this.child.stdin!.on('error', () => this.fail(new Error('ACP 输入管道关闭，请检查 agent 是否已退出')))
    // stderr 不是协议，且可能包含凭据；不转发原文。
    this.child.stderr!.resume()
    this.lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    this.lines.on('error', () => this.fail(new Error('ACP 输出读取失败，请重新启动 agent')))
    this.lines.on('line', line => {
      if (this.failure) return
      try { this.receive(object(JSON.parse(line))) }
      catch { this.fail(new Error('ACP 协议错误：stdout 必须逐行输出有效 JSON-RPC 2.0，请检查启动参数')) }
    })
  }

  private send(value: unknown): void {
    if (this.failure) throw this.failure
    this.child.stdin!.write(`${JSON.stringify(value)}\n`)
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<ObjectValue> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.fail(new Error(`ACP ${method} 超时（timeout），请检查 agent 响应或增大超时`))
      }, timeoutMs) : undefined
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { this.fail(error as Error) }
    })
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }) }

  private receive(message: ObjectValue): void {
    if (message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version')
    if (typeof message.method === 'string') {
      const params = object(message.params ?? {})
      if (!Object.hasOwn(message, 'id')) { this.onNotification(message.method, params); return }
      if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('Invalid request id')
      const method = message.method
      const work = Promise.resolve().then(() => this.onRequest(method, params)).then(
        result => this.send({ jsonrpc: '2.0', id: message.id, result }),
        error => this.send({ jsonrpc: '2.0', id: message.id, error: {
          code: error instanceof RpcError ? error.code : -32603,
          message: this.redact(error instanceof RpcError ? error.message : 'ACP 客户端操作失败，请检查路径和权限'),
        } }),
      ).catch(error => this.fail(error as Error)).finally(() => this.handlers.delete(work))
      this.handlers.add(work)
      return
    }
    if (typeof message.id !== 'number') throw new Error('Invalid response id')
    const pending = this.pending.get(message.id)
    if (!pending || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error('Invalid response')
    const error = message.error === undefined ? undefined : object(message.error)
    const result = error ? undefined : object(message.result)
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (error) pending.reject(new RpcError(typeof error.code === 'number' ? error.code : -32603,
      this.redact(`ACP 请求失败（${error.code}）：${String(error.message)}；请检查 agent 登录、参数与能力`)))
    else pending.resolve(result!)
  }

  fail(error: Error): void {
    this.failure ??= error
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(this.failure) }
    this.pending.clear()
  }

  private kill(signal: NodeJS.Signals): void {
    if (!this.child.pid) return
    try {
      if (process.platform === 'win32') { if (!this.closed) this.child.kill(signal) }
      else process.kill(-this.child.pid, signal)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.fail(new Error('ACP 进程回收失败，请检查本机权限')) }
  }

  async close(): Promise<void> {
    this.fail(new Error('ACP 连接已关闭'))
    this.lines.close()
    this.kill('SIGTERM')
    const escalation = setTimeout(() => this.kill('SIGKILL'), 200)
    try { await this.ended; await Promise.all(this.handlers) }
    finally { clearTimeout(escalation); this.kill('SIGKILL') }
  }
}
