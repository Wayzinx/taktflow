import { clearSourceStale, isSourceStale, markSourceStale, trackStale } from './stale.js'
import { configuredEmbedding } from './embedding.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, cp } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  auditKnowledge,
  changeKnowledgeConfig,
  estimateTokens,
  knowledgeFileLock,
  listFiles,
  readJsonFile,
  readJsonLines,
  sha256,
  validateSchema,
  writeFileAtomic,
  type Actor,
  type KnowledgeCaller,
  type KnowledgeBase,
  type KnowledgeBuild,
  type KnowledgeDoc,
  type KnowledgeEvalCase,
  type KnowledgeEvalRun,
  type KnowledgeKind,
  type KnowledgeKindContext,
  type KnowledgeQuery,
  type KnowledgeRetrieval,
  type KnowledgeStore,
  type ProjectStores,
  type SecretResolver,
} from '@taktflow/core'
import { createProjectSecretResolver, validateSecretFields } from './secrets.js'
import { entries, safeKey, safePath } from './files.js'
import { builtinKinds } from '../kinds/index.js'
import { loadIndex, saveIndex, trimHits } from '../kinds/search.js'
import { collectCurrentSourcePaths, STALE_SOURCE_SCAN_LIMIT } from '../kinds/source-paths.js'
import { appendQuery, readQueries } from './query-log.js'
import * as evaluation from '../eval/index.js'
export interface KnowledgeStoreOptions {
  sharedRoot?: string
  secrets?: SecretResolver
  embed?: KnowledgeKindContext['embed']
  chat?: (prompt: string) => Promise<string>
  kinds?: KnowledgeKind[]
}
const sourceHashes = new Map<string, { stamp: string; hash: string }>()
const activeBuilds = new Map<string, { controller: AbortController; promise?: Promise<void> }>()
export function inferKnowledgeIntent(query: KnowledgeQuery): NonNullable<KnowledgeQuery['intent']> {
  if (query.intent) return query.intent
  if (/调用|影响|依赖|\b(?:impact|caller)\b/i.test(query.text)) return 'impact'
  if (/表结构|字段|口径|\b(?:schema|column)\b/i.test(query.text)) return 'schema'
  if (/为什么|历史|\b(?:when|why)\b/i.test(query.text)) return 'history'
  if (/配置|状态|实时/.test(query.text)) return 'fact'
  if (/\b[a-z]+[A-Z]\w*\b|\b\w+\.\w+\s*\(/.test(query.text)) return 'symbol'
  return 'business'
}
export function createKnowledgeStore(
  stores: ProjectStores,
  opts: KnowledgeStoreOptions = {},
): KnowledgeStore {
  const kinds = new Map([...builtinKinds, ...(opts.kinds ?? [])].map((key2) => [key2.kind, key2]))
  const secrets = opts.secrets ?? createProjectSecretResolver(stores)
  const listeners = new Set<(build: KnowledgeBuild) => void>()
  const embed = opts.embed ?? configuredEmbedding(stores)
  const root = join(stores.projectDir, 'knowledge')
  const cache = join(stores.taktDir, 'knowledge')
  function roots(scope: KnowledgeBase['scope']) {
    if (scope === 'shared') {
      if (!opts.sharedRoot) throw new Error('共享知识库未配置 sharedRoot，请先配置共享目录')
      return {
        root: join(opts.sharedRoot, '.shared/knowledge'),
        cache: join(opts.sharedRoot, '.shared/.takt/knowledge'),
      }
    }
    return { root, cache }
  }
  const paths = async (kb: KnowledgeBase) => ({
    base: await safePath(roots(kb.scope).root, safeKey(kb.id)),
    cache: await safePath(roots(kb.scope).cache, safeKey(kb.id)),
  })
  const kind = (kb: KnowledgeBase) => {
    const result = kinds.get(kb.kind)
    if (!result) throw new Error(`未知知识库类型 ${kb.kind}，请安装对应插件`)
    return result
  }
  async function raw(id: string): Promise<KnowledgeBase | undefined> {
    safeKey(id)
    for (const scope of ['space', ...(opts.sharedRoot ? (['shared'] as const) : [])] as const) {
      const dir = await safePath(roots(scope).root, id)
      const kb = await readJsonFile<KnowledgeBase>(await safePath(dir, 'kb.json'))
      if (kb) {
        if (kb.id !== id || kb.scope !== scope)
          throw new Error('知识库配置身份不一致，请修复 kb.json')
        return kb
      }
    }
    return undefined
  }
  async function requireBase(id: string) {
    const kb = await raw(id)
    if (!kb) throw new Error(`知识库 ${id} 不存在，请检查 ID`)
    return kb
  }
  async function save(kb: KnowledgeBase) {
    const previous = await raw(kb.id)
    kb.updatedAt = new Date().toISOString()
    await trackStale(stores, kb, previous)
    await writeFileAtomic(
      await safePath((await paths(kb)).base, 'kb.json'),
      JSON.stringify(kb, null, 2),
    )
  }
  async function context(
    kb: KnowledgeBase,
    version = kb.version,
    signal?: AbortSignal,
  ): Promise<KnowledgeKindContext> {
    const paths2 = await paths(kb)
    return {
      stores,
      baseDir: paths2.base,
      indexDir: await safePath(paths2.cache, `v${version}`),
      secrets,
      embed,
      signal,
    }
  }
  function validate(kb: KnowledgeBase) {
    if (!kb.name?.trim()) throw new Error('名称不能为空，请填写知识库名称')
    if (!['space', 'shared'].includes(kb.scope))
      throw new Error('scope 不合法，请选择 space 或 shared')
    roots(kb.scope)
    try {
      validateSchema(kb.config, kind(kb).configSchema)
    } catch (error) {
      throw new Error(`知识库配置不合法，请检查配置：${(error as Error).message}`)
    }
    validateSecretFields(kb.config, kind(kb).configSchema)
    const record2 = kb.retrieval
    if (record2.rerank)
      throw new Error('rerank 模型尚未接入，请移除 rerank 参数，先使用 BM25 与向量混合检索')
    if (
      !Number.isInteger(record2.topK) ||
      record2.topK < 0 ||
      !Number.isInteger(record2.budgetTokens) ||
      record2.budgetTokens < 0 ||
      (record2.minScore !== undefined &&
        (!Number.isFinite(record2.minScore) || record2.minScore < 0 || record2.minScore > 1))
    )
      throw new Error('检索参数不合法，请检查 topK、预算和最低分')
    if (
      record2.hybrid &&
      Object.values(record2.hybrid).some((count2) => !Number.isFinite(count2) || count2 < 0)
    )
      throw new Error('混合检索权重必须非负，请修改权重')
    if (
      kb.intents.some(
        (index2) => !['business', 'fact', 'schema', 'symbol', 'impact', 'history'].includes(index2),
      )
    )
      throw new Error('intent 不合法，请选择支持的问题类型')
  }
  async function buildFile(kb: KnowledgeBase, id: string) {
    return safePath((await paths(kb)).cache, `builds/${safeKey(id)}.json`)
  }
  async function saveBuild(kb: KnowledgeBase, build: KnowledgeBuild) {
    await writeFileAtomic(
      await buildFile(kb, build.id),
      JSON.stringify({ ...build, ownerPid: process.pid }),
    )
    for (const listener of listeners) {
      try {
        listener(structuredClone(build))
      } catch {
        /* 订阅者异常不能改变构建结果。 */
      }
    }
  }
  async function recover(kb: KnowledgeBase, builds: KnowledgeBuild[]) {
    for (const build of builds) {
      const ownerPid = (build as KnowledgeBuild & { ownerPid?: number }).ownerPid
      let ownerAlive = false
      if (ownerPid && ownerPid !== process.pid)
        try {
          process.kill(ownerPid, 0)
          ownerAlive = true
        } catch (error) {
          ownerAlive = (error as NodeJS.ErrnoException).code === 'EPERM'
        }
      if (
        build.status === 'running' &&
        !ownerAlive &&
        !activeBuilds.has(await buildFile(kb, build.id))
      ) {
        // 读取列表到检查任务之间可能刚好完成，必须再读终态，避免旧快照覆盖成功结果。
        const latest = await readJsonFile<KnowledgeBuild>(await buildFile(kb, build.id))
        if (latest && latest.status !== 'running') {
          Object.assign(build, latest)
          continue
        }
        build.status = 'failed'
        build.endedAt = new Date().toISOString()
        build.log.push('服务重启中断')
        build.log = build.log.slice(-200)
        await saveBuild(kb, build)
        if (kb.status === 'building') {
          kb.status = kb.version ? 'stale' : 'error'
          kb.error = '服务重启中断，请重新构建'
          await save(kb)
        }
      }
    }
  }
  async function stale(kb: KnowledgeBase): Promise<number> {
    if (!kb.version || !kind(kb).needsBuild) return 0
    const ctx = await context(kb)
    const index = await loadIndex(ctx.indexDir).catch(() => undefined)
    if (!index) return 0
    let count = 0
    const manifest = index.manifest ?? []
    const manifestPaths = new Set(manifest.map((source) => source.path))
    const manifestResolvedPaths = new Set<string>()
    for (const source of manifest) {
      const path = await resolveSourcePath(kb, source.path)
      manifestResolvedPaths.add(path)
      try {
        if ((await sourceHash(path)) !== source.hash) count++
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        count++
      }
    }
    // 来源目录不在了 / 仓库解绑：manifest 那一侧已经计为过期，这里只找新增文件，不能让详情接口因此报错
    const currentSources = await collectCurrentSourcePaths(kb, ctx, { limit: STALE_SOURCE_SCAN_LIMIT }).catch(() => [])
    for (const source of currentSources)
      if (!manifestPaths.has(source.path) && !manifestResolvedPaths.has(source.full)) count++
    if (count && kb.status === 'ready') {
      kb.status = 'stale'
      await save(kb)
      await markSourceStale(stores, kb.id)
    } else if (!count && kb.status === 'stale' && (await isSourceStale(stores, kb.id))) {
      // 来源改回原样（或移动空间后重新定位成功）：不用重建，直接回到可用
      kb.status = 'ready'
      await save(kb)
    }
    return count
  }
  /** 源文件内容哈希，按 mtime / ctime / 大小缓存；文件不在时抛 ENOENT。 */
  async function sourceHash(path: string): Promise<string> {
    const info = await stat(path)
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
    let cached = sourceHashes.get(path)
    if (cached?.stamp !== stamp) {
      cached = { stamp, hash: sha256(await readFile(path)) }
      if (sourceHashes.size >= 10000) sourceHashes.delete(sourceHashes.keys().next().value!)
      sourceHashes.set(path, cached)
    }
    return cached.hash
  }
  async function resolveSourcePath(kb: KnowledgeBase, source: string): Promise<string> {
    if (!isAbsolute(source)) {
      return safePath(sourceRoot(kb), source)
    }
    try {
      await stat(source)
      return source
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const candidates = absoluteSourceRelocations(kb, source)
    for (const candidate of candidates) {
      try {
        await stat(candidate)
        return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return source
  }
  function absoluteSourceRelocations(kb: KnowledgeBase, source: string): string[] {
    const currentRoot = resolve(sourceRoot(kb))
    const normalized = resolve(source)
    const parts = normalized.split(sep).filter(Boolean)
    const candidates = new Set<string>()
    const ids = [stores.config.space?.id, stores.projectDir.split(sep).filter(Boolean).at(-1), kb.id].filter((item): item is string => !!item)
    for (const id of ids) {
      const index = parts.lastIndexOf(id)
      if (index >= 0 && index + 1 < parts.length) candidates.add(resolve(currentRoot, ...parts.slice(index + 1)))
    }
    const currentParts = currentRoot.split(sep).filter(Boolean)
    for (let suffix = Math.min(parts.length, currentParts.length); suffix >= 1; suffix--) {
      const tail = parts.slice(parts.length - suffix).join(sep)
      if (tail === currentParts.slice(currentParts.length - suffix).join(sep)) {
        candidates.add(resolve(currentRoot, ...parts.slice(parts.length - suffix + 1)))
        break
      }
    }
    for (const marker of ['knowledge', 'requirements', 'docs', 'inputs']) {
      const index = parts.lastIndexOf(marker)
      if (index >= 0) candidates.add(resolve(currentRoot, ...parts.slice(index)))
    }
    candidates.delete(normalized)
    return [...candidates]
  }
  function sourceRoot(kb: KnowledgeBase): string {
    return kb.scope === 'shared' ? roots(kb.scope).root : stores.projectDir
  }
  async function prune(kb: KnowledgeBase) {
    const paths3 = await paths(kb)
    const versions = (await entries(paths3.cache))
      .filter((count3) => /^v\d+$/.test(count3))
      .map((count4) => Number(count4.slice(1)))
      .sort((left, right) => right - left)
    const keep = new Set([
      ...(kb.version ? [kb.version] : []),
      ...(kb.candidateVersion ? [kb.candidateVersion] : []),
    ])
    for (const count5 of versions) if (keep.size < 3) keep.add(count5)
    for (const count6 of versions)
      if (!keep.has(count6))
        await rm(await safePath(paths3.cache, `v${count6}`), { recursive: true, force: true })
  }
  async function queryVersion(
    id: string,
    query2: KnowledgeQuery,
    version: number,
    retrievalOverride?: Partial<KnowledgeRetrieval>,
    caller?: KnowledgeCaller,
    record = true,
  ) {
    const started = Date.now()
    const kb = await requireBase(id)
    if (!version) throw new Error('知识库尚未发布或构建，请先构建并选择候选版本')
    const ctx = await context(kb, version)
    const snapshot = await readJsonFile<KnowledgeBase>(join(ctx.indexDir, 'base.json'))
    if (!snapshot) throw new Error('该版本索引已清理，请使用保留版本或重新构建')
    const retrieval = {
      ...snapshot.retrieval,
      ...retrievalOverride,
      ...(query2.limit !== undefined ? { topK: query2.limit } : {}),
    }
    validate({ ...snapshot, retrieval })
    let response: Awaited<ReturnType<KnowledgeKind['query']>>
    try {
      response = await kind(snapshot).query(snapshot, query2, ctx, retrieval)
    } catch (error) {
      if (record)
        await appendQuery(stores, {
          ...caller,
          queryId: caller?.queryId ?? randomUUID(),
          at: new Date().toISOString(),
          text: query2.text,
          intent: inferKnowledgeIntent(query2),
          bases: [{ id, version }],
          top: [],
          latencyMs: Date.now() - started,
          tokens: 0,
        })
      throw error
    }
    const hits = trimHits(Array.isArray(response) ? response : response.hits, retrieval).map(
      (hit2) => ({ ...hit2, baseId: id, version }),
    )
    const result = {
      executed: Array.isArray(response) ? undefined : response.executed,
      hits,
      latencyMs: Date.now() - started,
      tokens: hits.reduce((total2, hit3) => total2 + estimateTokens(hit3.snippet), 0),
      intent: inferKnowledgeIntent(query2),
    }
    if (record) {
      const identity = caller ?? {}
      await appendQuery(stores, {
        ...identity,
        queryId: identity.queryId ?? randomUUID(),
        at: new Date().toISOString(),
        text: query2.text,
        intent: result.intent,
        bases: [{ id, version }],
        top: hits,
        latencyMs: result.latencyMs,
        tokens: result.tokens,
      })
    }
    return result
  }
  const evalDeps = (): evaluation.EvalDeps => ({
    store,
    chat: opts.chat,
    query: (id, query3, version, retrieval) =>
      queryVersion(id, query3, version, retrieval, { via: 'eval' }),
    snapshot: async (id, version) => {
      const kb = await requireBase(id)
      const ctx = await context(kb, version)
      const snapshot = await readJsonFile<KnowledgeBase>(join(ctx.indexDir, 'base.json'))
      if (!snapshot) throw new Error('该版本索引不存在，请重新构建')
      const index = await readJsonFile<import('../kinds/search.js').Index>(
        join(ctx.indexDir, 'index/index.json'),
      )
      return { base: snapshot, chunks: index?.chunks ?? [] }
    },
    saveRun: async (run) => {
      const kb = await requireBase(run.baseId)
      await writeFileAtomic(
        await safePath((await paths(kb)).cache, `evals/runs/${safeKey(run.id)}.json`),
        JSON.stringify(run),
      )
    },
    queries: () => readQueries(stores),
    audit: (by, reason, message) => auditKnowledge(stores, by, reason, message),
  })
  async function performBuild(
    kb: KnowledgeBase,
    previous: KnowledgeBase,
    build: KnowledgeBuild,
    controller: AbortController,
    by: Actor,
    reason: string,
  ): Promise<void> {
    const id = kb.id
    const version = build.version

    let writes = Promise.resolve()
    try {
      const ctx = await context(kb, version, controller.signal)
      await mkdir(ctx.indexDir, { recursive: true })
      await writeFileAtomic(join(ctx.indexDir, 'base.json'), JSON.stringify(kb))
      controller.signal.throwIfAborted()
      let abortListener: () => void = () => {}
      const interrupted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error('构建已取消'))
        controller.signal.addEventListener('abort', abortListener, { once: true })
      })
      const result = await Promise.race([
        interrupted,
        Promise.resolve(
          kind(kb).build?.(kb, ctx, (build5) => {
            if (controller.signal.aborted) return
            const stage = {
              id: build5.stage,
              title: build5.stage,
              done: build5.done,
              total: build5.total,
              status: build5.done >= build5.total ? ('done' as const) : ('running' as const),
            }
            const index3 = build.stages.findIndex((build6) => build6.id === build5.stage)
            if (index3 < 0) build.stages.push(stage)
            else build.stages[index3] = stage
            if (build5.log) build.log = [...build.log, build5.log].slice(-200)
            if (build5.error) (build.errors ??= []).push(build5.error)
            const copy = structuredClone(build)
            writes = writes.then(() => saveBuild(kb, copy))
          }),
        ),
      ]).finally(() => controller.signal.removeEventListener('abort', abortListener))
      await writes
      controller.signal.throwIfAborted()
      build.status = 'succeeded'
      build.stats = result?.stats ?? { docs: 0, chunks: 0, bytes: 0 }
      const run = await readJsonFile<{ runId: string }>(join(ctx.indexDir, 'run.json'))
      if (run) build.runId = run.runId
      kb.candidateVersion = version
      kb.builtAt = new Date().toISOString()
      kb.stats = build.stats
      kb.status = kb.version ? 'stale' : 'draft'
    } catch (error) {
      await writes.catch(() => undefined)
      build.status = controller.signal.aborted ? 'cancelled' : 'failed'
      const message = controller.signal.aborted
        ? '构建已取消'
        : error instanceof Error
          ? error.message
          : String(error)
      if (error && typeof error === 'object' && 'ref' in error)
        (build.errors ??= []).push({ ref: String(error.ref), message })
      build.log = [...build.log, message].slice(-200)
      if (controller.signal.aborted) {
        Object.assign(kb, previous)
        if (previous.error === undefined) delete kb.error
      } else {
        kb.error = message
        kb.status = kb.version ? 'stale' : 'error'
      }
    }
    build.endedAt = new Date().toISOString()
    await save(kb)
    const runInfo = await readJsonFile<{ runId: string }>(
      join((await context(kb, version)).indexDir, 'run.json'),
    )
    if (runInfo) build.runId = runInfo.runId
    await prune(kb)
    await auditKnowledge(stores, by, reason, `knowledge.built:${id}:v${version}:${build.status}`)
    await saveBuild(kb, build)
  }
  const store: KnowledgeStore = {
    kinds: () => [...kinds.values()],
    async list() {
      const ids = new Set(
        (await entries(root)).filter((count7) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(count7)),
      )
      for (const binding of await store.bindings())
        if (binding.scope === 'shared') ids.add(binding.baseId)
      const bases = await Promise.all([...ids].map((id) => store.get(id)))
      return bases.filter((kb): kb is KnowledgeBase => !!kb)
    },
    async get(id) {
      const kb = await raw(id)
      if (!kb) return undefined
      await store.builds(id)
      const staleDocs = await stale(kb)
      await trackStale(stores, kb, kb)
      return { ...(await requireBase(id)), staleDocs }
    },
    async create(input, by, reason) {
      const id = safeKey(input.id ?? `kb-${randomUUID()}`)
      return knowledgeFileLock(
        join(roots(input.scope ?? 'space').cache, `${id}.mutation`),
        async () => {
          if (await raw(id)) throw new Error('知识库 ID 已存在，请换一个 ID')
          const now = new Date().toISOString()
          const kb: KnowledgeBase = {
            id,
            name: input.name,
            kind: input.kind,
            description: input.description ?? '',
            intents: input.intents ?? kinds.get(input.kind)?.intents ?? [],
            scope: input.scope ?? 'space',
            config: input.config,
            retrieval: {
              topK: 8,
              budgetTokens: 4000,
              ...stores.config.knowledgeDefaults?.retrieval,
              ...input.retrieval,
            },
            status: 'draft',
            version: 0,
            createdAt: now,
            updatedAt: now,
            createdBy: by,
          }
          validate(kb)
          await auditKnowledge(stores, by, reason, `knowledge.create:${id}`)
          await save(kb)
          return kb
        },
      )
    },
    async update(id, patch, by, reason) {
      return knowledgeFileLock(
        join(roots((await requireBase(id)).scope).cache, `${safeKey(id)}.mutation`),
        async () => {
          const old = await requireBase(id)
          const kb = { ...old }
          for (const key of ['name', 'description', 'intents', 'config', 'retrieval'] as const)
            if (patch[key] !== undefined) Object.assign(kb, { [key]: patch[key] })
          if (old.status === 'building') throw new Error('构建期间不能修改配置，请先取消构建')
          validate(kb)
          // 只有影响索引或版本快照的配置（config / retrieval）才需要重建；改名称、说明、意图不用
          const rebuild = (['config', 'retrieval'] as const).some((key) => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(old[key]))
          if (kb.version && rebuild) {
            kb.status = 'stale'
            await clearSourceStale(stores, id)
          }
          await auditKnowledge(stores, by, reason, `knowledge.update:${id}`)
          await save(kb)
          return kb
        },
      )
    },
    async remove(id, by, reason) {
      const kb = await requireBase(id)
      if ((await store.builds(id)).some((build2) => build2.status === 'running'))
        throw new Error('知识库正在构建，请先取消构建')
      await auditKnowledge(stores, by, reason, `knowledge.remove:${id}`)
      await store.setBindings(
        (await store.bindings()).filter((binding2) => binding2.baseId !== id),
        by,
        reason,
      )
      const paths4 = await paths(kb)
      await rm(paths4.base, { recursive: true, force: true })
      await rm(paths4.cache, { recursive: true, force: true })
    },
    async test(id) {
      const kb = await requireBase(id)
      return kind(kb).test(kb, await context(kb))
    },
    async upload(id, files, by) {
      const kb = await requireBase(id)
      if (kb.status === 'building') throw new Error('构建期间不能上传，请先取消构建')
      if (!['rag', 'llm-wiki'].includes(kb.kind))
        throw new Error('此类型不支持上传，请选择文档或 Wiki 知识库')
      const dir = await safePath((await paths(kb)).base, 'content')
      const checked = await Promise.all(
        files.map(async (file2) => ({ ...file2, full: await safePath(dir, file2.path) })),
      )
      if (checked.some((file3) => !/\.(md|txt|html?|json|csv)$/i.test(file3.path)))
        throw new Error('文件格式不支持，请上传 md、txt、html、json 或 csv')
      await auditKnowledge(stores, by, '上传知识文档', `knowledge.upload:${id}`)
      for (const file of checked) await writeFileAtomic(file.full, file.content)
      if (kb.version) {
        kb.status = 'stale'
        await save(kb)
        await clearSourceStale(stores, kb.id)
      }
      return { docs: files.length }
    },
    async docs(id) {
      const kb = await requireBase(id)
      const dir = await safePath((await paths(kb)).base, 'content')
      const ctx = await context(kb, kb.candidateVersion ?? kb.version)
      const index = await loadIndex(ctx.indexDir).catch(() => undefined)
      // 构建 manifest 和分块来源记的是相对空间的路径（旧索引是绝对路径），两种都认
      const manifest = new Map((index?.manifest ?? []).map((entry) => [entry.path, entry.hash]))
      const chunkSources = new Set(index?.chunks.map((chunk2) => chunk2.source))
      const indexed = (full: string, path?: string) =>
        chunkSources.has(full) || (path !== undefined && (manifest.has(path) || chunkSources.has(path)))
      const changed = async (full: string, path?: string) => {
        const hash = path === undefined ? undefined : manifest.get(path)
        return hash !== undefined && (await sourceHash(full)) !== hash
      }
      // 空间内目录、仓库这类数据源的文件不在 content 下，按当前数据源列出，并对照上次构建标出过期
      const current = kind(kb).needsBuild
        ? await collectCurrentSourcePaths(kb, ctx, { limit: STALE_SOURCE_SCAN_LIMIT }).catch(() => [])
        : []
      const byFull = new Map(current.map((source) => [source.full, source.path]))
      let files: string[] = []
      try {
        files = await listFiles(dir, ['**'])
      } catch (error2) {
        if ((error2 as NodeJS.ErrnoException).code !== 'ENOENT') throw error2
      }
      const uploads = await Promise.all(
        files.map(async (path): Promise<KnowledgeDoc> => {
          const full = await safePath(dir, path)
          const info = await stat(full)
          const source = byFull.get(full)
          return {
            path,
            bytes: info.size,
            updatedAt: info.mtime.toISOString(),
            indexed: indexed(full, source),
            ...((await changed(full, source)) ? { stale: true } : {}),
          }
        }),
      )
      const listed = new Set(current.map((source) => source.path))
      const sourced = await Promise.all(
        current
          .filter((source) => !source.full.startsWith(dir + sep))
          .map(async (source): Promise<KnowledgeDoc> => {
            const info = await stat(source.full)
            return {
              path: source.path,
              bytes: info.size,
              updatedAt: info.mtime.toISOString(),
              indexed: indexed(source.full, source.path),
              ...((await changed(source.full, source.path)) ? { stale: true } : {}),
            }
          }),
      )
      // 上次构建时在、现在源文件已经没了的：也列出来，标为已删除
      const removed: KnowledgeDoc[] = []
      for (const path of manifest.keys()) {
        if (listed.has(path)) continue
        const full = await resolveSourcePath(kb, path)
        if (await stat(full).then(() => true, () => false)) continue
        removed.push({ path, bytes: 0, updatedAt: kb.builtAt ?? kb.updatedAt, indexed: true, stale: true, deleted: true })
      }
      return [...uploads, ...sourced, ...removed]
    },
    async build(id, by, reason) {
      return knowledgeFileLock(
        join(roots((await requireBase(id)).scope).cache, `${safeKey(id)}.mutation`),
        async () => {
          const kb = await requireBase(id)
          const history = await store.builds(id)
          const previous = structuredClone(kb)
          if (history.some((build3) => build3.status === 'running'))
            throw new Error('已有构建正在执行，请等待或取消')
          const version =
            Math.max(
              kb.version,
              kb.candidateVersion ?? 0,
              ...history.map((build4) => build4.version),
            ) + 1
          const build: KnowledgeBuild = {
            id: `build-${randomUUID()}`,
            baseId: id,
            version,
            status: 'running',
            startedAt: new Date().toISOString(),
            by,
            stages: [],
            log: [],
          }
          await auditKnowledge(stores, by, reason, `knowledge.build:${id}:v${version}`)
          const key = await buildFile(kb, build.id)
          const controller = new AbortController()
          const active: { controller: AbortController; promise?: Promise<void> } = { controller }
          activeBuilds.set(key, active)
          kb.status = 'building'
          delete kb.error
          await save(kb)
          await saveBuild(kb, build)
          const snapshot = structuredClone(build)
          const cancelFile = `${key}.cancel`
          const cancelTimer = setInterval(() => {
            void stat(cancelFile)
              .then(() => controller.abort())
              .catch(() => undefined)
          }, 200)
          cancelTimer.unref()
          active.promise = performBuild(kb, previous, build, controller, by, reason)
            .catch(async (error) => {
              build.status = 'failed'
              build.endedAt = new Date().toISOString()
              build.log = [
                ...build.log,
                `构建收尾失败，请重试：${error instanceof Error ? error.message : String(error)}`,
              ].slice(-200)
              kb.status = kb.version ? 'stale' : 'error'
              kb.error = build.log.at(-1)
              await save(kb)
              await saveBuild(kb, build)
            })
            .finally(async () => {
              clearInterval(cancelTimer)
              activeBuilds.delete(key)
              await rm(cancelFile, { force: true })
            })
          // 终态与日志由任务本身落盘；不让后台异常成为未处理拒绝。
          void active.promise.catch(() => undefined)
          return snapshot
        },
      )
    },
    async builds(id, limit) {
      const kb = await requireBase(id)
      const dir = await safePath((await paths(kb)).cache, 'builds')
      const builds = (
        await Promise.all(
          (await entries(dir))
            .filter((count8) => count8.endsWith('.json'))
            .map((count9) => readJsonFile<KnowledgeBuild>(join(dir, count9))),
        )
      ).filter((build7): build7 is KnowledgeBuild => !!build7)
      await recover(kb, builds)
      return builds
        .sort((build8, build9) => build9.version - build8.version)
        .slice(0, limit ?? builds.length)
    },
    async getBuild(id, buildId) {
      safeKey(buildId)
      return (await store.builds(id)).find((build10) => build10.id === buildId)
    },
    async cancelBuild(id, buildId, by) {
      const kb = await requireBase(id)
      const build = await store.getBuild(id, buildId)
      if (!build) throw new Error('构建不存在，请刷新构建列表')
      await auditKnowledge(stores, by, '取消构建', `knowledge.cancel:${id}:${buildId}`)
      const file = await buildFile(kb, buildId)
      const task = activeBuilds.get(file)
      if (build.status === 'running') await writeFileAtomic(`${file}.cancel`, 'cancel')
      task?.controller.abort()
      if (task?.promise) await task.promise
      return (await store.getBuild(id, buildId))!
    },
    onBuild(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async publish(id, input) {
      if (!input.reason?.trim()) throw new Error('发布必须提供 reason，请填写发布原因')
      const kb = await requireBase(id)
      if (kb.status === 'building') throw new Error('构建尚未完成，请等待后发布')
      if (!kind(kb).needsBuild && !kb.candidateVersion && !input.version) {
        const build = await store.build(id, input.by, input.reason)
        const job = activeBuilds.get(await buildFile(kb, build.id))
        await job?.promise
        return store.publish(id, { ...input, version: build.version })
      }
      const version = input.version ?? kb.candidateVersion
      if (
        !version ||
        !(await store.builds(id)).some(
          (build11) => build11.version === version && build11.status === 'succeeded',
        )
      )
        throw new Error('没有成功的候选版本，请先构建')
      if (input.by.type !== 'human' && kb.kind === 'llm-wiki' && kb.config.generate)
        throw new Error('生成的 Wiki 必须由人批准，请人工发布')
      const gate = await evaluation.publishGate(evalDeps(), id, { ...input, version })
      if (!gate.pass && !input.force) return { base: kb, gate }
      await auditKnowledge(
        stores,
        input.by,
        input.reason,
        `knowledge.published:${id}:v${version}:${input.force ? 'force' : 'normal'}`,
      )
      const ctx = await context(kb, version)
      if (!(await readJsonFile(join(ctx.indexDir, 'base.json'))))
        throw new Error('该版本已清理，请重新构建')
      if (kb.kind === 'llm-wiki' && kb.config.generate) {
        const generated = join(ctx.indexDir, 'generated')
        for (const path of await listFiles(generated, ['**/*.md'])) {
          const target = await safePath(ctx.baseDir, `content/${path}`)
          await mkdir(join(target, '..'), { recursive: true })
          await cp(await safePath(generated, path), target)
        }
        const index = await loadIndex(ctx.indexDir)
        const generatedProjectPath = relative(stores.projectDir, generated)
        const generatedRelative = (path: string) => {
          if (isAbsolute(path)) return relative(generated, path)
          return path === generatedProjectPath
            ? ''
            : path.startsWith(`${generatedProjectPath}/`)
              ? path.slice(generatedProjectPath.length + 1)
              : path
        }
        const publishedSource = (path: string) => kb.scope === 'shared'
          ? `${kb.id}/content/${generatedRelative(path)}`
          : `knowledge/${kb.id}/content/${generatedRelative(path)}`
        for (const source of index.manifest ?? [])
          source.path = publishedSource(source.path)
        for (const chunk of index.chunks)
          if (chunk.source)
            chunk.source = publishedSource(chunk.source)
        await saveIndex(ctx.indexDir, index)
      }
      kb.version = version
      kb.status = 'ready'
      kb.publishedAt = new Date().toISOString()
      if (kb.candidateVersion === version) delete kb.candidateVersion
      await save(kb)
      await prune(kb)
      return { base: kb, gate }
    },
    async query(id, query4, options = {}) {
      const kb = await requireBase(id)
      const version =
        options.version === 'candidate' ? (kb.candidateVersion ?? kb.version) : kb.version
      return queryVersion(id, query4, version, options.retrieval, options.caller)
    },
    async route(query5, options) {
      const started = Date.now()
      const intent = inferKnowledgeIntent(query5)
      const listed = (
        await Promise.all((await store.bindings()).map((binding) => raw(binding.baseId)))
      ).filter((base): base is KnowledgeBase => !!base)
      const bindings = await store.bindings()
      const bases = await Promise.all(
        listed.map(async (base) => {
          if (!base.version) return base
          const snapshot = await readJsonFile<KnowledgeBase>(
            join((await context(base)).indexDir, 'base.json'),
          )
          return snapshot ? { ...base, intents: snapshot.intents } : base
        }),
      )
      const role = options.caller?.role ?? options.role
      const eligible = bindings
        .filter(
          (binding3) =>
            binding3.enabled &&
            (!options.bases || options.bases.includes(binding3.baseId)) &&
            (!query5.bases || query5.bases.includes(binding3.baseId)) &&
            (!binding3.roles || (!!role && binding3.roles.includes(role))),
        )
        .map((binding) => ({ binding, base: bases.find((base2) => base2.id === binding.baseId) }))
        .filter((item) => item.base?.version)
        .sort((base3, base4) => base3.binding.priority - base4.binding.priority)
      const matching = eligible.filter((item) =>
        (item.binding.intents ?? item.base!.intents).includes(intent),
      )
      const selected = !query5.intent && !matching.length ? eligible : matching
      const results = await Promise.all(
        selected.map(async ({ base, binding }) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const result = await Promise.race([
              queryVersion(
                base!.id,
                { ...query5, intent },
                base!.version,
                undefined,
                options.caller,
                false,
              ),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('查询超时（8 秒）')), 8000)
              }),
            ])
            return { base: base!, binding, hits: result.hits }
          } catch (error) {
            await auditKnowledge(
              stores,
              { type: 'system', id: 'knowledge' },
              '知识查询失败',
              `knowledge.query:${base!.id}:${error instanceof Error ? error.message : '失败'}`,
            )
            return { base: base!, binding, hits: [] }
          } finally {
            clearTimeout(timer)
          }
        }),
      )
      const merged = new Map<
        string,
        { hit: import('@taktflow/core').KnowledgeHit; score: number; priority: number }
      >()
      for (const result of results)
        result.hits.forEach((hit, rank) => {
          const old = merged.get(hit.ref)
          const score = 1 / (61 + rank)
          if (old) old.score += score
          else merged.set(hit.ref, { hit, score, priority: result.binding.priority })
        })
      const retrieval = {
        topK: query5.limit ?? stores.config.knowledgeDefaults?.retrieval?.topK ?? 8,
        budgetTokens: stores.config.knowledgeDefaults?.retrieval?.budgetTokens ?? 4000,
      }
      const hits = trimHits(
        [...merged.values()]
          .sort((hit4, hit5) => hit5.score - hit4.score || hit4.priority - hit5.priority)
          .map((hit6) => ({
            ...hit6.hit,
            score: hit6.score,
            scores: { ...hit6.hit.scores, rrf: hit6.score },
          })),
        retrieval,
      )
      const result = {
        queryId: options.caller?.queryId ?? randomUUID(),
        hits,
        bases: results.map((base5) => ({ id: base5.base.id, version: base5.base.version })),
        latencyMs: Date.now() - started,
        tokens: hits.reduce((total3, hit7) => total3 + estimateTokens(hit7.snippet), 0),
      }
      const identity = options.caller ?? {}
      await appendQuery(stores, {
        ...identity,
        queryId: result.queryId,
        at: new Date().toISOString(),
        text: query5.text,
        intent,
        bases: result.bases,
        top: hits,
        latencyMs: result.latencyMs,
        tokens: result.tokens,
      })
      return result
    },
    async bindings() {
      return (
        (await readJsonFile<ProjectStores['config']>(join(stores.projectDir, 'takt.config.json')))
          ?.knowledgeBindings ??
        stores.config.knowledgeBindings ??
        []
      )
    },
    async setBindings(bindings, by, reason) {
      const ids = new Set<string>()
      for (const binding4 of bindings) {
        const kb = await requireBase(binding4.baseId)
        if (
          kb.scope !== binding4.scope ||
          ids.has(binding4.baseId) ||
          !Number.isFinite(binding4.priority) ||
          typeof binding4.enabled !== 'boolean'
        )
          throw new Error('绑定不合法，请检查范围、优先级和重复 ID')
        ids.add(binding4.baseId)
      }
      await changeKnowledgeConfig(stores, by, reason, 'knowledge.bind', (config) => {
        config.knowledgeBindings = bindings
      })
      return bindings
    },
    async evalSets(id) {
      const kb = await requireBase(id)
      const dir = await safePath((await paths(kb)).base, 'evals')
      return Promise.all(
        (await entries(dir))
          .filter((count10) => count10.endsWith('.jsonl'))
          .map(async (count11) => ({
            id: count11.slice(0, -6),
            title: count11.slice(0, -6),
            cases: await readJsonLines<KnowledgeEvalCase>(await safePath(dir, count11)),
          })),
      )
    },
    async upsertCases(id, setId, cases, by) {
      const kb = await requireBase(id)
      const file = await safePath((await paths(kb)).base, `evals/${safeKey(setId)}.jsonl`)
      return knowledgeFileLock(file, async () => {
        const existing = await readJsonLines<KnowledgeEvalCase>(file)
        const map = new Map(existing.map((evalCase) => [evalCase.id, evalCase]))
        for (const evalCase2 of cases) {
          const cid = safeKey(evalCase2.id ?? `case-${randomUUID()}`)
          if (
            !evalCase2.query?.trim() ||
            !['manual', 'synthetic', 'harvested', 'defect'].includes(evalCase2.source) ||
            !['active', 'candidate', 'retired'].includes(evalCase2.status) ||
            evalCase2.relevant.some((record3) => ![1, 2, 3].includes(record3.grade))
          )
            throw new Error('评测用例不合法，请检查问题、来源、状态和相关性')
          map.set(cid, {
            ...evalCase2,
            id: cid,
            createdAt: map.get(cid)?.createdAt ?? new Date().toISOString(),
            createdBy: map.get(cid)?.createdBy ?? by,
          })
        }
        await auditKnowledge(stores, by, '更新评测用例', `knowledge.evals:${id}:${setId}`)
        const values = [...map.values()]
        await writeFileAtomic(
          file,
          values.map((evalCase3) => JSON.stringify(evalCase3)).join('\n') + '\n',
        )
        return values
      })
    },
    synthesizeCases: (...args) => evaluation.synthesizeCases(evalDeps(), ...args),
    harvestCases: (...args) => evaluation.harvestCases(evalDeps(), ...args),
    runEval: (...args) => evaluation.runEval(evalDeps(), ...args),
    async getEvalRun(id, runId) {
      const kb = await requireBase(id)
      return readJsonFile<KnowledgeEvalRun>(
        await safePath((await paths(kb)).cache, `evals/runs/${safeKey(runId)}.json`),
      )
    },
    async evalRuns(id) {
      const kb = await requireBase(id)
      const dir = await safePath((await paths(kb)).cache, 'evals/runs')
      return (
        await Promise.all(
          (await entries(dir))
            .filter((count12) => count12.endsWith('.json'))
            .map((count13) => store.getEvalRun(id, count13.slice(0, -5))),
        )
      ).filter((record4): record4 is KnowledgeEvalRun => !!record4)
    },
  }
  return store
}
