import { randomBytes } from 'node:crypto'
import type { ToolSpec } from '@taktflow/core'
import { body, HttpError } from './http.js'
import { STREAMING, type Handler } from './routes.js'

interface Turn {
  userId: string
  threadId: string
  specs: ToolSpec[]
  call(name: string, input: Record<string, unknown>): Promise<unknown>
}

export class StewardMcp {
  private readonly turns = new Map<string, Turn>()
  issue(turn: Turn): { token: string; revoke(): void } {
    const token = randomBytes(32).toString('hex')
    this.turns.set(token, turn)
    return { token, revoke: () => { this.turns.delete(token) } }
  }
  close(): void { this.turns.clear() }
  readonly handle: Handler = async ({ request, response }) => {
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))
      throw new HttpError(403, 'MCP 仅允许本机访问，请从本机管家会话重试')
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1]
    const turn = token ? this.turns.get(token) : undefined
    if (!turn) throw new HttpError(401, '本轮 MCP 令牌无效或已过期，请重新发送消息')
    if (request.headers['x-takt-user'] && request.headers['x-takt-user'] !== turn.userId)
      throw new HttpError(403, 'MCP 令牌不属于此用户，请重新发送消息')
    const input = await body(request)
    if (!token || this.turns.get(token) !== turn) throw new HttpError(401, '本轮 MCP 令牌已过期，请重新发送消息')
    const id = input.id ?? null
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
    if (input.jsonrpc !== '2.0' || typeof input.method !== 'string') return error(-32600, '请求格式错误，请使用 JSON-RPC 2.0')
    if (input.method === 'notifications/initialized') {
      response.writeHead(202).end()
      return STREAMING
    }
    let result: unknown
    if (input.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'takt', version: '1.0.0' } }
    else if (input.method === 'tools/list') result = { tools: turn.specs.map(spec => ({ name: spec.name, description: spec.description, inputSchema: spec.parameters })) }
    else if (input.method === 'tools/call') {
      const params = input.params as { name?: unknown; arguments?: unknown; threadId?: unknown } | undefined
      if (!params || typeof params.name !== 'string' || !turn.specs.some(spec => spec.name === params.name)) return error(-32602, '工具不存在，请先调用 tools/list')
      if (params.threadId !== undefined && params.threadId !== turn.threadId) return error(-32602, '令牌仅可用于当前会话，请重新发送消息')
      if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) return error(-32602, '工具参数需要对象，请修正后重试')
      try {
        result = { content: [{ type: 'text', text: JSON.stringify(await turn.call(params.name, (params.arguments ?? {}) as Record<string, unknown>)) }] }
      } catch (cause) {
        result = { isError: true, content: [{ type: 'text', text: `工具执行失败，请检查参数或权限：${cause instanceof Error ? cause.message : String(cause)}` }] }
      }
    } else return error(-32601, '不支持此 MCP 方法，请使用 initialize、tools/list 或 tools/call')
    return { jsonrpc: '2.0', id, result }
  }
}
