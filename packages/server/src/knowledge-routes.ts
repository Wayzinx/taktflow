import {
  migrateKnowledge,
  type KnowledgeBaseSummary,
  type KnowledgeBaseDetail,
  type KnowledgeBinding,
  type KnowledgeCreateRequest,
  type KnowledgeEvalCase,
  type KnowledgeEvalRunRequest,
  type KnowledgeKindInfo,
  type KnowledgeQueryRequest,
  type KnowledgeQueryResponse,
  type KnowledgeStore,
  type KnowledgeUpdateRequest,
  type KnowledgeUploadRequest,
  type ProjectStores,
  type SecretResolver,
} from '@taktflow/core'
import { knowledgeUsage, createProjectSecretResolver } from '@taktflow/knowledge'
import { actor, authorize, body, HttpError, json, safeId, text } from './http.js'
import { auditSpace } from './space.js'
import { STREAMING, type Handler, type RequestContext } from './routes.js'
export interface KnowledgeRouteDeps {
  resolveStore?: (stores: ProjectStores) => KnowledgeStore
  secrets?: SecretResolver
  connections?: Set<() => void>
}
export function registerKnowledgeRoutes(
  router:
    | { add(method: string, path: string, handler: Handler): void }
    | ((method: string, path: string, handler: Handler) => void),
  deps: KnowledgeRouteDeps = {},
): void {
  const add = typeof router === 'function' ? router : router.add.bind(router)
  const store = (s: ProjectStores) => {
    const kb = deps.resolveStore?.(s) ?? s.kb
    if (!kb) throw new HttpError(503, '知识库未接入，请先初始化 KnowledgeStore')
    return kb
  }
  const id = (c: RequestContext) => safeId(c.params.id!)
  const required = async <T>(value: Promise<T | undefined>) => {
    const item = await value
    if (!item) throw new HttpError(404, '记录不存在，请刷新列表')
    return item
  }
  async function summary(stores: ProjectStores, id: string): Promise<KnowledgeBaseSummary> {
    const kb = store(stores),
      base = await required(kb.get(id)),
      usage = await knowledgeUsage(stores, id),
      builds = await kb.builds(id),
      running = builds.find((b) => b.status === 'running'),
      stage = running?.stages.find((s) => s.status === 'running') ?? running?.stages.at(-1)
    const lastEval = (await kb.evalRuns(id))
      .filter((r) => r.status === 'done')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
    const metric = lastEval && Object.values(lastEval.metrics).at(-1)
    return {
      ...base,
      bound: (await kb.bindings()).some((b) => b.baseId === id),
      usage7d: usage.usage7d,
      ...(running
        ? {
            building: {
              buildId: running.id,
              stage: stage?.id ?? 'parse',
              done: stage?.done ?? 0,
              total: stage?.total ?? 0,
            },
          }
        : {}),
      ...(lastEval && metric
        ? {
            lastEval: {
              runId: lastEval.id,
              recall10: metric.recall10,
              at: lastEval.endedAt ?? lastEval.startedAt,
            },
          }
        : {}),
    }
  }
  function route(
    method: string,
    path: string,
    fn: Handler,
    role: 'viewer' | 'member' | 'maintainer' = method === 'GET' ? 'viewer' : 'maintainer',
  ) {
    add(method, `/api/knowledge${path}`, async (c) => {
      authorize(c.request, c.stores, role)
      for (const value of Object.values(c.params)) safeId(value)
      try {
        return await fn(c)
      } catch (error) {
        if (error instanceof HttpError) throw error
        const message = error instanceof Error ? error.message : '知识库操作失败，请检查输入后重试'
        const status = /不存在/.test(message)
          ? 404
          : /已存在|构建期间|正在构建|已有构建|构建尚未/.test(message)
            ? 409
            : 400
        throw new HttpError(status, message)
      }
    })
  }
  route('GET', '/kinds', async ({ stores }): Promise<KnowledgeKindInfo[]> =>
    Promise.all(
      store(stores)
        .kinds()
        .map(async (k) => {
          const available = (await k.available?.()) ?? { ok: true }
          return {
            kind: k.kind,
            title: k.title,
            summary: k.summary,
            example: k.example,
            intents: k.intents,
            configSchema: k.configSchema,
            needsBuild: k.needsBuild,
            available: available.ok,
            reason: available.reason,
          }
        }),
    ),
  )
  route('GET', '/bases', async ({ stores }) =>
    Promise.all((await store(stores).list()).map((b) => summary(stores, b.id))),
  )
  route('POST', '/bases', async (c) => {
    const input = (await body(c.request)) as unknown as KnowledgeCreateRequest,
      kb = store(c.stores)
    const reason = text(input.reason, 'reason'),
      by = actor(c.request, c.stores)
    const base = await kb.create(
      { ...input, retrieval: { topK: 8, budgetTokens: 4000, ...input.retrieval } },
      by,
      reason,
    )
    if (input.bind !== false)
      await kb.setBindings(
        [
          ...(await kb.bindings()),
          { baseId: base.id, scope: base.scope, enabled: true, priority: 0 },
        ],
        by,
        reason,
      )
    return summary(c.stores, base.id)
  })
  route('GET', '/bases/:id', async (c): Promise<KnowledgeBaseDetail> => {
    const kb = store(c.stores),
      baseId = id(c),
      usage = await knowledgeUsage(c.stores, baseId)
    return {
      ...(await summary(c.stores, baseId)),
      bindings: (await kb.bindings())
        .filter((b) => b.baseId === baseId)
        .map((b) => ({ ...b, spaceId: c.stores.config.space?.id ?? c.stores.config.project.name })),
      builds: await kb.builds(baseId),
      evalSets: (await kb.evalSets(baseId)).map((s) => ({
        id: s.id,
        title: s.title,
        total: s.cases.length,
        candidates: s.cases.filter((c) => c.status === 'candidate').length,
        bySource: Object.fromEntries(
          ['manual', 'synthetic', 'harvested', 'defect'].map((source) => [
            source,
            s.cases.filter((c) => c.source === source).length,
          ]),
        ),
      })),
      usage: usage.usage,
    }
  })
  route('PATCH', '/bases/:id', async (c) => {
    const input = (await body(c.request)) as unknown as KnowledgeUpdateRequest,
      kb = store(c.stores),
      base = await required(kb.get(id(c)))
    const { reason, retrieval, ...patch } = input
    await kb.update(
      id(c),
      { ...patch, ...(retrieval ? { retrieval: { ...base.retrieval, ...retrieval } } : {}) },
      actor(c.request, c.stores),
      text(reason, 'reason'),
    )
    return summary(c.stores, id(c))
  })
  route('DELETE', '/bases/:id', async (c) => {
    await store(c.stores).remove(
      id(c),
      actor(c.request, c.stores),
      text((await body(c.request)).reason, 'reason'),
    )
    c.response.writeHead(204)
    c.response.end()
    return STREAMING
  })
  route('POST', '/bases/:id/test', (c) => store(c.stores).test(id(c)))
  route('POST', '/bases/:id/upload', async (c) => {
    const input = (await body(c.request)) as unknown as KnowledgeUploadRequest
    if (!Array.isArray(input.files))
      throw new HttpError(400, 'files 必须是文件数组，请重新选择文件')
    return store(c.stores).upload(
      id(c),
      input.files.map((f) => {
        if (!['utf8', 'base64', undefined].includes(f.encoding))
          throw new HttpError(400, '编码不合法，请使用 utf8 或 base64')
        return {
          path: text(f.path, 'path'),
          content: Buffer.from(text(f.content, 'content', true), f.encoding ?? 'utf8'),
        }
      }),
      actor(c.request, c.stores),
    )
  })
  route('GET', '/bases/:id/docs', (c) => store(c.stores).docs(id(c)))
  route('GET', '/bases/:id/builds', (c) => store(c.stores).builds(id(c)))
  route('POST', '/bases/:id/builds', async (c) =>
    store(c.stores).build(
      id(c),
      actor(c.request, c.stores),
      text((await body(c.request)).reason, 'reason'),
    ),
  )
  route('GET', '/bases/:id/builds/:buildId', (c) =>
    required(store(c.stores).getBuild(id(c), c.params.buildId!)),
  )
  route('POST', '/bases/:id/builds/:buildId/cancel', (c) =>
    store(c.stores).cancelBuild(id(c), c.params.buildId!, actor(c.request, c.stores)),
  )
  route('GET', '/bases/:id/builds/:buildId/stream', async (c) => {
    const kb = store(c.stores),
      buildId = c.params.buildId!,
      baseId = id(c)
    await required(kb.getBuild(baseId, buildId))
    let closed = false,
      last = '',
      timer: ReturnType<typeof setInterval> | undefined
    let unsubscribe = () => {}
    const close = () => {
      if (closed) return
      closed = true
      unsubscribe()
      clearInterval(timer)
      deps.connections?.delete(close)
      c.response.end()
    }
    const send = (build: Awaited<ReturnType<KnowledgeStore['getBuild']>>) => {
      if (closed || !build || build.id !== buildId || build.baseId !== baseId) return
      const data = JSON.stringify(build)
      if (data !== last) {
        last = data
        c.response.write(`data: ${data}\n\n`)
      }
      if (build.status !== 'running') close()
    }
    c.response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    c.response.flushHeaders()
    c.response.once('close', close)
    c.response.once('error', close)
    deps.connections?.add(close)
    unsubscribe = kb.onBuild(send)
    send(await kb.getBuild(baseId, buildId))
    if (!closed) {
      timer = setInterval(() => {
        void kb.getBuild(baseId, buildId).then(send).catch(close)
      }, 1000)
      timer.unref()
    }
    return STREAMING
  })
  route(
    'POST',
    '/bases/:id/query',
    async (c): Promise<KnowledgeQueryResponse> => {
      const input = (await body(c.request)) as unknown as KnowledgeQueryRequest
      const query = { text: text(input.text, 'text'), intent: input.intent, limit: input.topK }
      return store(c.stores).query(id(c), query, {
        version: input.version ?? 'candidate',
        retrieval: input.retrieval,
        caller: { via: 'playground' },
      })
    },
    'member',
  )
  route('POST', '/bases/:id/publish', async (c) => {
    const input = await body(c.request),
      result = await store(c.stores).publish(id(c), {
        by: actor(c.request, c.stores),
        reason: text(input.reason, 'reason'),
        version: input.version as number | undefined,
        force: input.force === true,
      })
    const response = { ...result, base: await summary(c.stores, id(c)) }
    if (!result.gate.pass && input.force !== true) {
      json(c.response, response, 409)
      return STREAMING
    }
    return response
  })
  route('GET', '/bases/:id/evals', (c) => store(c.stores).evalSets(id(c)))
  route('PUT', '/bases/:id/evals/:setId/cases', async (c) => {
    const input = await body(c.request)
    if (!Array.isArray(input.cases)) throw new HttpError(400, 'cases 必须是数组')
    return store(c.stores).upsertCases(
      id(c),
      c.params.setId!,
      input.cases as KnowledgeEvalCase[],
      actor(c.request, c.stores),
    )
  })
  route('POST', '/bases/:id/evals/:setId/synthesize', async (c) =>
    store(c.stores).synthesizeCases(
      id(c),
      c.params.setId!,
      Number((await body(c.request)).count),
      actor(c.request, c.stores),
    ),
  )
  route('POST', '/bases/:id/evals/:setId/harvest', (c) =>
    store(c.stores).harvestCases(id(c), c.params.setId!, actor(c.request, c.stores)),
  )
  route('GET', '/bases/:id/eval-runs', (c) => store(c.stores).evalRuns(id(c)))
  route('POST', '/bases/:id/eval-runs', async (c) =>
    store(c.stores).runEval(id(c), {
      ...((await body(c.request)) as unknown as KnowledgeEvalRunRequest),
      by: actor(c.request, c.stores),
    }),
  )
  route('GET', '/bases/:id/eval-runs/:runId', (c) =>
    required(store(c.stores).getEvalRun(id(c), c.params.runId!)),
  )
  route('GET', '/bindings', (c) => store(c.stores).bindings())
  route('PUT', '/bindings', async (c) => {
    const input = await body(c.request)
    if (!Array.isArray(input.bindings)) throw new HttpError(400, 'bindings 必须是数组')
    return store(c.stores).setBindings(
      input.bindings as KnowledgeBinding[],
      actor(c.request, c.stores),
      text(input.reason, 'reason'),
    )
  })
  route(
    'GET',
    '/secrets',
    (c) => (deps.secrets ?? createProjectSecretResolver(c.stores)).list(),
    'maintainer',
  )
  route('PUT', '/secrets/:name', async (c) => {
    const name = c.params.name!,
      input = await body(c.request)
    await auditSpace(
      c.stores,
      actor(c.request, c.stores),
      input.reason === undefined ? '设置知识库密钥' : text(input.reason, 'reason'),
      `knowledge.secret:${name}`,
    )
    await (deps.secrets ?? createProjectSecretResolver(c.stores)).set(
      name,
      text(input.value, 'value'),
    )
    return { name }
  })
  route('POST', '/migrate', async (c) => {
    const input = await body(c.request)
    c.stores.kb ??= store(c.stores)
    return migrateKnowledge(
      c.stores,
      { dryRun: input.dryRun === true, reason: input.reason as string | undefined },
      actor(c.request, c.stores),
    )
  })
}
