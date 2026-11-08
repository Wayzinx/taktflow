import type { AcpHarnessConfig, HarnessRequest } from '@taktflow/core'
import { AcpEvents } from './events.js'
import { AcpFiles } from './files.js'
import { array, object, string, RpcError, type ObjectValue } from './protocol.js'

export function clientRequests(config: AcpHarnessConfig, req: HarnessRequest, files: AcpFiles, events: AcpEvents,
  session: () => string | undefined) {
  return async (method: string, params: ObjectValue): Promise<unknown> => {
    if (!['session/request_permission', 'fs/read_text_file', 'fs/write_text_file'].includes(method)) {
      throw new RpcError(-32601, '未支持此 ACP 方法；client 终端未启用')
    }
    const checkSession = () => {
      if (!session() || params.sessionId !== session()) throw new RpcError(-32602, 'ACP 会话不匹配，请使用当前 sessionId')
    }
    if (method === 'session/request_permission') {
      let audit: ObjectValue = { allowed: false, reason: '请求无效或会话不匹配' }
      try {
        checkSession()
        const call = object(params.toolCall)
        const known = events.calls.get(string(call.toolCallId))
        const tool = { ...known, ...call }
        let allowed = config.permissions !== 'reject' && !req.signal?.aborted
        // 不知目标或种类时不猜权限；只读下只放行明确的读/搜/取/思考。
        if (req.readOnly && !['read', 'search', 'fetch', 'think'].includes(String(tool.kind))) allowed = false
        const paths: string[] = []
        for (const location of array(tool.locations ?? [])) paths.push(string(object(location).path))
        if (tool.rawInput && typeof tool.rawInput === 'object') {
          const input = object(tool.rawInput)
          for (const key of ['path', 'file_path', 'source', 'destination']) if (typeof input[key] === 'string') paths.push(input[key])
        }
        if (!paths.length) allowed = false
        for (const path of paths) {
          try { await files.resolve(path) } catch { allowed = false }
        }
        const options = array(params.options).map(object)
        const option = req.signal?.aborted ? undefined : options.find(item => item.kind === (allowed ? 'allow_once' : 'reject_once'))
        const outcome = option ? { outcome: 'selected', optionId: string(option.optionId) } : { outcome: 'cancelled' }
        audit = { toolCallId: call.toolCallId, kind: tool.kind, paths, allowed: allowed && !!option, outcome }
        return { outcome }
      } finally { events.audit('permission', audit) }
    }
    checkSession()
    if (req.signal?.aborted) throw new RpcError(-32000, '运行已取消，拒绝文件操作')
    const path = string(params.path)
    try {
      if (method === 'fs/write_text_file') { await files.write(path, string(params.content)); return {} }
      for (const field of ['line', 'limit']) {
        if (params[field] != null && (!Number.isSafeInteger(params[field]) || (params[field] as number) < 0)) {
          throw new RpcError(-32602, '行号与行数必须是非负整数，请修正请求')
        }
      }
      return { content: await files.read(path, params.line == null ? undefined : params.line as number, params.limit == null ? undefined : params.limit as number) }
    } catch (error) {
      events.audit('file_denied', { method, path })
      throw error
    }
  }
}
