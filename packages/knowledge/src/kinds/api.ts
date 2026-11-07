import { readSource } from './source-reader.js'
import {
  sha256,
  type KnowledgeBase,
  type KnowledgeKind,
  type KnowledgeKindContext,
} from '@taktflow/core'
import { safePath } from '../store/files.js'
import { fetchText } from './documents.js'
import { bm25, loadIndex, makeIndex, saveIndex, trimHits } from './search.js'
import { KnowledgeBlockedError } from './database.js'
interface Operation {
  id: string
  method: string
  path: string
  title: string
  description: string
  parameters: unknown
}
async function schema(
  kb: KnowledgeBase,
  ctx: KnowledgeKindContext,
): Promise<{ operations: Operation[]; server?: string; localSource?: { path: string; hash: string } }> {
  const source = kb.config.openapi
  let localSource: { path: string; hash: string } | undefined
  const doc =
    typeof source === 'object' && source
      ? (source as Record<string, unknown>)
      : (JSON.parse(await (async () => {
          if (/^https?:\/\//i.test(String(source))) return fetchText(String(source), ctx, undefined, 8 * 1024 * 1024)
          const path = await safePath(ctx.stores.projectDir, String(source))
          const raw = await readSource(path, ctx)
          localSource = { path: String(source), hash: sha256(raw) }
          return raw
        })()) as Record<string, unknown>)
  if (!String(doc.openapi).startsWith('3.'))
    throw new Error('只支持 OpenAPI 3 JSON，请转换文件后重新导入')
  const operations: Operation[] = []
  for (const [path, item] of Object.entries(
    (doc.paths as Record<string, Record<string, Record<string, unknown>>>) ?? {},
  )) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue
      operations.push({
        id: String(op.operationId ?? `${method.toUpperCase()} ${path}`),
        method: method.toUpperCase(),
        path,
        title: String(op.summary ?? op.operationId ?? path),
        description: String(op.description ?? ''),
        parameters: op.parameters ?? [],
      })
    }
  }
  return { operations, server: (doc.servers as Array<{ url: string }> | undefined)?.[0]?.url, localSource }
}
export const apiKind: KnowledgeKind = {
  kind: 'api',
  title: '接口',
  summary: 'OpenAPI 操作检索和允许的 GET 实时查询',
  intents: ['fact'],
  needsBuild: true,
  configSchema: {
    type: 'object',
    required: ['openapi'],
    properties: {
      allow: { type: 'array', items: { type: 'string' } },
      baseURL: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string', format: 'secret' } },
      maxBytes: { type: 'integer' },
    },
  },
  async test(kb, ctx) {
    const { operations } = await schema(kb, ctx)
    return {
      ok: true,
      message: `读取 ${operations.length} 个操作，请勾选允许调用的 GET`,
      preview: operations
        .slice(0, 200)
        .map((operation) => ({
          title: operation.title,
          ref: operation.id,
          snippet: `${operation.method} ${operation.path}`,
        })),
    }
  },
  async build(kb, ctx, progress) {
    const { operations, server, localSource } = await schema(kb, ctx)
    const index = makeIndex(
      operations.map((operation2) => {
        const content = JSON.stringify({ ...operation2, server })
        return {
          ref: operation2.id,
          title: `${operation2.title} ${operation2.method} ${operation2.path}`,
          content,
          hash: sha256(content),
        }
      }),
    )
    if (localSource) index.manifest = [localSource]
    await saveIndex(ctx.indexDir, index)
    progress({ stage: 'index', done: operations.length, total: operations.length })
    return {
      stats: {
        docs: operations.length,
        chunks: operations.length,
        bytes: JSON.stringify(index).length,
        operations: operations.length,
      },
    }
  },
  async query(kb, query2, ctx, retrieval) {
    try {
      const index = await loadIndex(ctx.indexDir)
      const call = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i.exec(query2.text.trim())
      if (call) {
        const block = (reason: string): never => {
          throw new KnowledgeBlockedError(
            'http',
            query2.text,
            `${reason}，请在允许列表中选择 GET 操作`,
          )
        }
        if (call[1]!.toUpperCase() !== 'GET') block('本期只允许 GET')
        const target = call[2]!
        if (
          target.startsWith('//') ||
          target.includes('\\') ||
          target.includes('#') ||
          /%2f|%5c|%2e/i.test(target) ||
          target
            .split('?')[0]!
            .split('/')
            .some((total2) => total2 === '..' || total2 === '.')
        )
          block('请求路径不合法')
        const path = target.split('?')[0]!
        const operations = index.chunks.map(
          (chunk) => JSON.parse(chunk.content) as Operation & { server?: string },
        )
        const op = operations.find(
          (operation3) =>
            operation3.method === 'GET' &&
            new RegExp(
              `^${operation3.path
                .split('/')
                .map((total3) =>
                  /^\{[^}]+\}$/.test(total3)
                    ? '[^/]+'
                    : total3.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                )
                .join('/')}$`,
            ).test(path),
        )
        if (
          !op ||
          !(kb.config.allow as string[] | undefined)?.some(
            (id) => id === op.id || id === `GET ${op.path}`,
          )
        )
          block('操作未获授权')
        const headers: Record<string, string> = {}
        for (const [name, ref] of Object.entries(
          (kb.config.headers as Record<string, string>) ?? {},
        )) {
          const secret = await ctx.secrets.resolve(ref)
          if (!secret) throw new Error('认证密钥不存在，请先保存密钥')
          headers[name] = secret
        }
        const base = String(kb.config.baseURL ?? op!.server ?? '')
        if (!/^https?:\/\//i.test(base)) throw new Error('接口服务器地址缺失，请配置 baseURL')
        const maxBytes = Number(kb.config.maxBytes ?? 200 * 1024)
        if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024)
          throw new Error('响应大小限制不合法，请设置 1 到 8388608 字节')
        let content = await fetchText(`${base.replace(/\/$/, '')}${target}`, ctx, headers, maxBytes)
        for (const secret of Object.values(headers))
          if (secret) content = content.split(secret).join('[已脱敏]')
        return {
          executed: { kind: 'http', text: query2.text },
          hits: [
            {
              sourceId: kb.id,
              ref: op!.id,
              title: `GET ${path}`,
              snippet: content,
              content,
              score: 1,
              evidenceLevel: 'verified',
              fetchedAt: new Date().toISOString(),
            },
          ],
        }
      }
      return trimHits(
        bm25(index, query2.text).map((record) => ({
          sourceId: kb.id,
          ref: index.chunks[record.i]!.ref,
          title: index.chunks[record.i]!.title,
          snippet: index.chunks[record.i]!.content,
          content: index.chunks[record.i]!.content,
          score: record.score / (1 + record.score),
        })),
        retrieval,
      )
    } catch (error) {
      if (error instanceof KnowledgeBlockedError)
        return {
          hits: [],
          executed: { kind: error.kind, text: error.text, blocked: error.message },
        }
      throw error
    }
  },
}
