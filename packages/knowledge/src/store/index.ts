import { AsyncLocalStorage } from 'node:async_hooks'
import { configuredEmbedding } from './embedding.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { appendKnowledgeQuery, auditKnowledge, changeKnowledgeConfig, estimateTokens, knowledgeFileLock, knowledgeQueryContext, listFiles, readJsonFile, readJsonLines, sha256, validateSchema, writeFileAtomic, type Actor, type KnowledgeBase, type KnowledgeBuild, type KnowledgeEvalCase, type KnowledgeEvalRun, type KnowledgeKind, type KnowledgeKindContext, type KnowledgeQuery, type KnowledgeRetrieval, type KnowledgeStore, type ProjectStores, type SecretResolver } from '@taktflow/core'
import { createSecretResolver, validateSecretFields } from './secrets.js'
import { entries, safeKey, safePath } from './files.js'
import { builtinKinds } from '../kinds/index.js'
import { loadIndex, saveIndex, trimHits } from '../kinds/search.js'
import * as evaluation from '../eval/index.js'
export interface KnowledgeStoreOptions {
  sharedRoot?: string
  secrets?: SecretResolver
  embed?: KnowledgeKindContext['embed']
  chat?: (prompt: string) => Promise<string>
  kinds?: KnowledgeKind[]
}
const activeBuilds = new Map<string, { controller: AbortController; promise?: Promise<void> }>()
export const inferKnowledgeIntent = (q: KnowledgeQuery) => q.intent ?? (/调用|影响|依赖|impact|caller/i.test(q.text) ? 'impact' : /表|字段|口径|schema|column/i.test(q.text) ? 'schema' : /为什么|历史|when|why/i.test(q.text) ? 'history' : /配置|状态|实时/i.test(q.text) ? 'fact' : /[._]|[a-z][A-Z]|\(\)/.test(q.text) ? 'symbol' : 'business')
export function createKnowledgeStore(stores: ProjectStores, opts: KnowledgeStoreOptions = {}): KnowledgeStore {
  const kinds = new Map([...builtinKinds, ...(opts.kinds ?? [])].map(k => [k.kind, k])), secrets = opts.secrets ?? createSecretResolver()
  const listeners = new Set<(build: KnowledgeBuild) => void>()
  const routed = new AsyncLocalStorage<boolean>()
  const embed = opts.embed ?? configuredEmbedding(stores)
  const root = join(stores.projectDir, 'knowledge'), cache = join(stores.taktDir, 'knowledge')
  function roots(scope: KnowledgeBase['scope']) {
    if (scope === 'shared') {
      if (!opts.sharedRoot) throw new Error('共享知识库未配置 sharedRoot，请先配置共享目录')
      return { root: join(opts.sharedRoot, '.shared/knowledge'), cache: join(opts.sharedRoot, '.shared/.takt/knowledge') }
    }
    return { root, cache }
  }
  const paths = async (kb: KnowledgeBase) => ({ base: await safePath(roots(kb.scope).root, safeKey(kb.id)), cache: await safePath(roots(kb.scope).cache, safeKey(kb.id)) })
  const kind = (kb: KnowledgeBase) => { const result = kinds.get(kb.kind); if (!result) throw new Error(`未知知识库类型 ${kb.kind}，请安装对应插件`); return result }
  async function raw(id: string): Promise<KnowledgeBase | undefined> {
    safeKey(id)
    for (const scope of ['space', ...(opts.sharedRoot ? ['shared'] as const : [])] as const) {
      const dir = await safePath(roots(scope).root, id), kb = await readJsonFile<KnowledgeBase>(await safePath(dir, 'kb.json'))
      if (kb) { if (kb.id !== id || kb.scope !== scope) throw new Error('知识库配置身份不一致，请修复 kb.json'); return kb }
    }
    return undefined
  }
  async function requireBase(id: string) { const kb = await raw(id); if (!kb) throw new Error(`知识库 ${id} 不存在，请检查 ID`); return kb }
  async function save(kb: KnowledgeBase) { kb.updatedAt = new Date().toISOString(); await writeFileAtomic(await safePath((await paths(kb)).base, 'kb.json'), JSON.stringify(kb, null, 2)) }
  async function context(kb: KnowledgeBase, version = kb.version, signal?: AbortSignal): Promise<KnowledgeKindContext> {
    const p = await paths(kb)
    return { stores, baseDir: p.base, indexDir: await safePath(p.cache, `v${version}`), secrets, embed, signal }
  }
  function validate(kb: KnowledgeBase) {
    if (!kb.name?.trim()) throw new Error('名称不能为空，请填写知识库名称')
    if (!['space', 'shared'].includes(kb.scope)) throw new Error('scope 不合法，请选择 space 或 shared')
    roots(kb.scope)
    try { validateSchema(kb.config, kind(kb).configSchema) } catch (error) { throw new Error(`知识库配置不合法，请检查配置：${(error as Error).message}`) }
    validateSecretFields(kb.config, kind(kb).configSchema)
    const r = kb.retrieval
    if (r.rerank) throw new Error('rerank 模型尚未接入，请移除 rerank 参数，先使用 BM25 与向量混合检索')
    if (!Number.isInteger(r.topK) || r.topK < 0 || !Number.isInteger(r.budgetTokens) || r.budgetTokens < 0 || (r.minScore !== undefined && (!Number.isFinite(r.minScore) || r.minScore < 0 || r.minScore > 1))) throw new Error('检索参数不合法，请检查 topK、预算和最低分')
    if (r.hybrid && Object.values(r.hybrid).some(n => !Number.isFinite(n) || n < 0)) throw new Error('混合检索权重必须非负，请修改权重')
    if (kb.intents.some(i => !['business', 'fact', 'schema', 'symbol', 'impact', 'history'].includes(i))) throw new Error('intent 不合法，请选择支持的问题类型')
  }
  async function buildFile(kb: KnowledgeBase, id: string) { return safePath((await paths(kb)).cache, `builds/${safeKey(id)}.json`) }
  async function saveBuild(kb: KnowledgeBase, build: KnowledgeBuild) {
    await writeFileAtomic(await buildFile(kb, build.id), JSON.stringify({ ...build, ownerPid: process.pid }))
    for (const listener of listeners) { try { listener(structuredClone(build)) } catch { /* 订阅者异常不能改变构建结果。 */ } }
  }
  async function recover(kb: KnowledgeBase, builds: KnowledgeBuild[]) {
    for (const build of builds) {
      const ownerPid = (build as KnowledgeBuild & { ownerPid?: number }).ownerPid
      let ownerAlive = false
      if (ownerPid && ownerPid !== process.pid) try { process.kill(ownerPid, 0); ownerAlive = true } catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code === 'EPERM' }
      if (build.status === 'running' && !ownerAlive && !activeBuilds.has(await buildFile(kb, build.id))) {
        // 读取列表到检查任务之间可能刚好完成，必须再读终态，避免旧快照覆盖成功结果。
        const latest = await readJsonFile<KnowledgeBuild>(await buildFile(kb, build.id))
        if (latest && latest.status !== 'running') { Object.assign(build, latest); continue }
        build.status = 'failed'; build.endedAt = new Date().toISOString(); build.log.push('服务重启中断'); build.log = build.log.slice(-200)
        await saveBuild(kb, build)
        if (kb.status === 'building') { kb.status = kb.version ? 'stale' : 'error'; kb.error = '服务重启中断，请重新构建'; await save(kb) }
      }
    }
  }
  async function stale(kb: KnowledgeBase): Promise<number> {
    if (!kb.version || !kind(kb).needsBuild) return 0
    const ctx = await context(kb), index = await loadIndex(ctx.indexDir).catch(() => undefined)
    if (!index) return 0
    let count = 0
    for (const source of index.manifest ?? []) {
      try { if (sha256(await readFile(source.path)) !== source.hash) count++ } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; count++ }
    }
    if (count && kb.status === 'ready') { kb.status = 'stale'; await save(kb) }
    return count
  }
  async function prune(kb: KnowledgeBase) {
    const p = await paths(kb), versions = (await entries(p.cache)).filter(n => /^v\d+$/.test(n)).map(n => Number(n.slice(1))).sort((a, b) => b - a)
    const keep = new Set([...(kb.version ? [kb.version] : []), ...(kb.candidateVersion ? [kb.candidateVersion] : [])])
    for (const n of versions) if (keep.size < 3) keep.add(n)
    for (const n of versions) if (!keep.has(n)) await rm(await safePath(p.cache, `v${n}`), { recursive: true, force: true })
  }
  const store: KnowledgeStore = {
    kinds: () => [...kinds.values()],
    async list() {
      const ids = new Set((await entries(root)).filter(n => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n)))
      for (const binding of await store.bindings()) if (binding.scope === 'shared') ids.add(binding.baseId)
      const bases = await Promise.all([...ids].map(id => store.get(id)))
      return bases.filter((kb): kb is KnowledgeBase => !!kb)
    },
    async get(id) {
      const kb = await raw(id); if (!kb) return undefined
      await store.builds(id); await stale(kb)
      return { ...await requireBase(id), staleDocs: await stale(kb) }
    },
    async create(input, by, reason) {
      const id = safeKey(input.id ?? `kb-${randomUUID()}`)
      return knowledgeFileLock(join(cache, `${id}.mutation`), async () => {
        if (await raw(id)) throw new Error('知识库 ID 已存在，请换一个 ID')
        const now = new Date().toISOString(), kb: KnowledgeBase = { id, name: input.name, kind: input.kind, description: input.description ?? '', intents: input.intents ?? kinds.get(input.kind)?.intents ?? [], scope: input.scope ?? 'space', config: input.config, retrieval: { topK: 8, budgetTokens: 4000, ...stores.config.knowledgeDefaults?.retrieval, ...input.retrieval }, status: 'draft', version: 0, createdAt: now, updatedAt: now, createdBy: by }
        validate(kb); await auditKnowledge(stores, by, reason, `knowledge.create:${id}`); await save(kb)
        return kb
      })
    },
    async update(id, patch, by, reason) {
      return knowledgeFileLock(join(cache, `${safeKey(id)}.mutation`), async () => {
        const old = await requireBase(id), kb = { ...old }
        for (const key of ['name', 'description', 'intents', 'config', 'retrieval'] as const) if (patch[key] !== undefined) Object.assign(kb, { [key]: patch[key] })
        if (old.status === 'building') throw new Error('构建期间不能修改配置，请先取消构建')
        validate(kb); if (kb.version) kb.status = 'stale'
        await auditKnowledge(stores, by, reason, `knowledge.update:${id}`); await save(kb); return kb
      })
    },
    async remove(id, by, reason) {
      const kb = await requireBase(id)
      if ((await store.builds(id)).some(b => b.status === 'running')) throw new Error('知识库正在构建，请先取消构建')
      await auditKnowledge(stores, by, reason, `knowledge.remove:${id}`)
      await store.setBindings((await store.bindings()).filter(b => b.baseId !== id), by, reason)
      const p = await paths(kb); await rm(p.base, { recursive: true, force: true }); await rm(p.cache, { recursive: true, force: true })
    },
    async test(id) { const kb = await requireBase(id); return kind(kb).test(kb, await context(kb)) },
    async upload(id, files, by) {
      const kb = await requireBase(id)
      if (kb.status === 'building') throw new Error('构建期间不能上传，请先取消构建')
      if (!['rag', 'llm-wiki'].includes(kb.kind)) throw new Error('此类型不支持上传，请选择文档或 Wiki 知识库')
      const dir = await safePath((await paths(kb)).base, 'content')
      const checked = await Promise.all(files.map(async f => ({ ...f, full: await safePath(dir, f.path) })))
      if (checked.some(f => !/\.(md|txt|html?|json|csv)$/i.test(f.path))) throw new Error('文件格式不支持，请上传 md、txt、html、json 或 csv')
      await auditKnowledge(stores, by, '上传知识文档', `knowledge.upload:${id}`)
      for (const file of checked) await writeFileAtomic(file.full, file.content)
      if (kb.version) { kb.status = 'stale'; await save(kb) }
      return { docs: files.length }
    },
    async docs(id) {
      const kb = await requireBase(id), dir = await safePath((await paths(kb)).base, 'content')
      const index = await loadIndex((await context(kb, kb.candidateVersion ?? kb.version)).indexDir).catch(() => undefined)
      let files: string[] = []; try { files = await listFiles(dir, ['**']) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      return Promise.all(files.map(async path => { const full = await safePath(dir, path), info = await stat(full); return { path, bytes: info.size, updatedAt: info.mtime.toISOString(), indexed: index?.chunks.some(c => c.source === full) ?? false } }))
    },
    async build(id, by, reason) {
      return knowledgeFileLock(join(cache, `${safeKey(id)}.mutation`), async () => {
        const kb = await requireBase(id), history = await store.builds(id)
        if (history.some(b => b.status === 'running')) throw new Error('已有构建正在执行，请等待或取消')
        const version = Math.max(kb.version, kb.candidateVersion ?? 0, ...history.map(b => b.version)) + 1
        const build: KnowledgeBuild = { id: `build-${randomUUID()}`, baseId: id, version, status: 'running', startedAt: new Date().toISOString(), by, stages: [], log: [] }
        await auditKnowledge(stores, by, reason, `knowledge.build:${id}:v${version}`)
        const key = await buildFile(kb, build.id), controller = new AbortController(), active: { controller: AbortController; promise?: Promise<void> } = { controller }
        activeBuilds.set(key, active)
        kb.status = 'building'; delete kb.error; await save(kb); await saveBuild(kb, build)
        const snapshot = structuredClone(build)
        const cancelFile = `${key}.cancel`
        const cancelTimer = setInterval(() => { void stat(cancelFile).then(() => controller.abort()).catch(() => undefined) }, 200)
        cancelTimer.unref()
        active.promise = (async () => {
          let writes = Promise.resolve()
          try {
            const ctx = await context(kb, version, controller.signal)
            await mkdir(ctx.indexDir, { recursive: true })
            await writeFileAtomic(join(ctx.indexDir, 'base.json'), JSON.stringify(kb))
            controller.signal.throwIfAborted()
            let abortListener: () => void = () => {}
            const interrupted = new Promise<never>((_, reject) => { abortListener = () => reject(new Error('构建已取消')); controller.signal.addEventListener('abort', abortListener, { once: true }) })
            const result = await Promise.race([interrupted, Promise.resolve(kind(kb).build?.(kb, ctx, p => {
              if (controller.signal.aborted) return
              const stage = { id: p.stage, title: p.stage, done: p.done, total: p.total, status: p.done >= p.total ? 'done' as const : 'running' as const }
              const i = build.stages.findIndex(s => s.id === p.stage); if (i < 0) build.stages.push(stage); else build.stages[i] = stage
              if (p.log) build.log = [...build.log, p.log].slice(-200)
              if (p.error) (build.errors ??= []).push(p.error)
              const copy = structuredClone(build); writes = writes.then(() => saveBuild(kb, copy))
            }))]).finally(() => controller.signal.removeEventListener('abort', abortListener))
            await writes; controller.signal.throwIfAborted()
            build.status = 'succeeded'; build.stats = result?.stats ?? { docs: 0, chunks: 0, bytes: 0 }
            const run = await readJsonFile<{ runId: string }>(join(ctx.indexDir, 'run.json')); if (run) build.runId = run.runId
            kb.candidateVersion = version; kb.builtAt = new Date().toISOString(); kb.stats = build.stats; kb.status = kb.version ? 'stale' : 'draft'
          } catch (error) {
            await writes.catch(() => undefined)
            build.status = controller.signal.aborted ? 'cancelled' : 'failed'
            const message = controller.signal.aborted ? '构建已取消' : error instanceof Error ? error.message : String(error)
            if (error && typeof error === 'object' && 'ref' in error) (build.errors ??= []).push({ ref: String(error.ref), message })
            build.log = [...build.log, message].slice(-200); kb.error = message; kb.status = kb.version ? 'stale' : 'error'
          }
          build.endedAt = new Date().toISOString(); await save(kb); const runInfo = await readJsonFile<{ runId: string }>(join((await context(kb, version)).indexDir, 'run.json')); if (runInfo) build.runId = runInfo.runId; await prune(kb)
          await auditKnowledge(stores, by, reason, `knowledge.built:${id}:v${version}:${build.status}`)
          await saveBuild(kb, build)
        })().catch(async error => {
          build.status = 'failed'; build.endedAt = new Date().toISOString()
          build.log = [...build.log, `构建收尾失败，请重试：${error instanceof Error ? error.message : String(error)}`].slice(-200)
          kb.status = kb.version ? 'stale' : 'error'; kb.error = build.log.at(-1)
          await save(kb); await saveBuild(kb, build)
        }).finally(async () => { clearInterval(cancelTimer); activeBuilds.delete(key); await rm(cancelFile, { force: true }) })
        // 终态与日志由任务本身落盘；不让后台异常成为未处理拒绝。
        void active.promise.catch(() => undefined)
        return snapshot
      })
    },
    async builds(id, limit) {
      const kb = await requireBase(id), dir = await safePath((await paths(kb)).cache, 'builds')
      const builds = (await Promise.all((await entries(dir)).filter(n => n.endsWith('.json')).map(n => readJsonFile<KnowledgeBuild>(join(dir, n))))).filter((b): b is KnowledgeBuild => !!b)
      await recover(kb, builds)
      return builds.sort((a, b) => b.version - a.version).slice(0, limit ?? builds.length)
    },
    async getBuild(id, buildId) { safeKey(buildId); return (await store.builds(id)).find(b => b.id === buildId) },
    async cancelBuild(id, buildId, by) {
      const kb = await requireBase(id), build = await store.getBuild(id, buildId)
      if (!build) throw new Error('构建不存在，请刷新构建列表')
      await auditKnowledge(stores, by, '取消构建', `knowledge.cancel:${id}:${buildId}`)
      const file = await buildFile(kb, buildId), task = activeBuilds.get(file)
      if (build.status === 'running') await writeFileAtomic(`${file}.cancel`, 'cancel')
      task?.controller.abort()
      if (task?.promise) await task.promise
      return (await store.getBuild(id, buildId))!
    },
    onBuild(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async publish(id, input) {
      const kb = await requireBase(id)
      if (kb.status === 'building') throw new Error('构建尚未完成，请等待后发布')
      if (!kind(kb).needsBuild && !kb.candidateVersion && !input.version) {
        const build = await store.build(id, input.by, input.reason)
        const job = activeBuilds.get(await buildFile(kb, build.id)); await job?.promise
        return store.publish(id, { ...input, version: build.version })
      }
      const version = input.version ?? kb.candidateVersion
      if (!version || !(await store.builds(id)).some(b => b.version === version && b.status === 'succeeded')) throw new Error('没有成功的候选版本，请先构建')
      if (input.by.type !== 'human' && kb.kind === 'llm-wiki' && kb.config.generate) throw new Error('生成的 Wiki 必须由人批准，请人工发布')
      const gate = await evaluation.publishGate({ store, chat: opts.chat }, id, input)
      if (!gate.pass && !input.force) return { base: kb, gate }
      await auditKnowledge(stores, input.by, input.reason, `knowledge.published:${id}:v${version}:${input.force ? 'force' : 'normal'}`)
      const ctx = await context(kb, version)
      if (!await readJsonFile(join(ctx.indexDir, 'base.json'))) throw new Error('该版本已清理，请重新构建')
      if (kb.kind === 'llm-wiki' && kb.config.generate) {
        const generated = join(ctx.indexDir, 'generated')
        for (const path of await listFiles(generated, ['**/*.md'])) { const target = await safePath(ctx.baseDir, `content/${path}`); await mkdir(join(target, '..'), { recursive: true }); await cp(await safePath(generated, path), target) }
        const index = await loadIndex(ctx.indexDir)
        for (const source of index.manifest ?? []) source.path = await safePath(ctx.baseDir, `content/${source.path.slice(generated.length + 1)}`)
        for (const chunk of index.chunks) if (chunk.source) chunk.source = await safePath(ctx.baseDir, `content/${chunk.source.slice(generated.length + 1)}`)
        await saveIndex(ctx.indexDir, index)
      }
      kb.version = version; kb.status = 'ready'; kb.publishedAt = new Date().toISOString(); if (kb.candidateVersion === version) delete kb.candidateVersion
      await save(kb)
      await prune(kb)
      return { base: kb, gate }
    },
    async query(id, q, options = {}) {
      const started = Date.now(), kb = await requireBase(id), version = options.version === 'candidate' ? kb.candidateVersion ?? kb.version : kb.version
      if (!version) throw new Error('知识库尚未发布或构建，请先构建并选择候选版本')
      const ctx = await context(kb, version), snapshot = await readJsonFile<KnowledgeBase>(join(ctx.indexDir, 'base.json'))
      if (!snapshot) throw new Error('该版本索引已清理，请使用保留版本或重新构建')
      const retrieval = { ...snapshot.retrieval, ...options.retrieval, ...(q.limit !== undefined ? { topK: q.limit } : {}) }
      validate({ ...snapshot, retrieval })
      const hits = trimHits(await kind(snapshot).query(snapshot, q, ctx, retrieval), retrieval).map(h => ({ ...h, baseId: id, version }))
      const result = { hits, latencyMs: Date.now() - started, tokens: hits.reduce((s, h) => s + estimateTokens(h.snippet), 0), intent: inferKnowledgeIntent(q) }
      if (!routed.getStore()) {
        const identity = knowledgeQueryContext.getStore() ?? {}
        await appendKnowledgeQuery(stores, { ...identity, queryId: identity.queryId ?? randomUUID(), at: new Date().toISOString(), text: q.text, intent: result.intent, bases: [{ id, version }], top: hits, latencyMs: result.latencyMs, tokens: result.tokens })
      }
      return result
    },
    async route(q, options) {
      const started = Date.now(), intent = inferKnowledgeIntent(q), listed = await store.list(), bindings = await store.bindings()
      const bases = await Promise.all(listed.map(async base => {
        if (!base.version) return base
        const snapshot = await readJsonFile<KnowledgeBase>(join((await context(base)).indexDir, 'base.json'))
        return snapshot ? { ...base, intents: snapshot.intents } : base
      }))
      const selected = bindings.filter(b => b.enabled && (!options.bases || options.bases.includes(b.baseId)) && (!q.bases || q.bases.includes(b.baseId)) && (!b.roles || (!!options.role && b.roles.includes(options.role))))
        .map(binding => ({ binding, base: bases.find(k => k.id === binding.baseId) })).filter(item => item.base?.version && (item.binding.intents ?? item.base.intents).includes(intent)).sort((a, b) => a.binding.priority - b.binding.priority)
      const results = await Promise.all(selected.map(async ({ base, binding }) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([routed.run(true, () => store.query(base!.id, { ...q, intent })), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('查询超时（8 秒）')), 8000) })])
          return { base: base!, binding, hits: result.hits }
        } catch (error) {
          await auditKnowledge(stores, { type: 'system', id: 'knowledge' }, '知识查询失败', `knowledge.query:${base!.id}:${error instanceof Error ? error.message : '失败'}`)
          return { base: base!, binding, hits: [] }
        } finally { clearTimeout(timer) }
      }))
      const merged = new Map<string, { hit: import('@taktflow/core').KnowledgeHit; score: number; priority: number }>()
      for (const result of results) result.hits.forEach((hit, rank) => { const old = merged.get(hit.ref), score = 1 / (61 + rank); if (old) old.score += score; else merged.set(hit.ref, { hit, score, priority: result.binding.priority }) })
      const retrieval = { topK: q.limit ?? stores.config.knowledgeDefaults?.retrieval?.topK ?? 8, budgetTokens: stores.config.knowledgeDefaults?.retrieval?.budgetTokens ?? 4000 }
      const hits = trimHits([...merged.values()].sort((a, b) => b.score - a.score || a.priority - b.priority).map(v => ({ ...v.hit, score: v.score, scores: { ...v.hit.scores, rrf: v.score } })), retrieval)
      const result = { hits, bases: results.map(r => ({ id: r.base.id, version: r.base.version })), latencyMs: Date.now() - started, tokens: hits.reduce((s, h) => s + estimateTokens(h.snippet), 0) }
      const identity = knowledgeQueryContext.getStore() ?? {}
      await appendKnowledgeQuery(stores, { ...identity, queryId: identity.queryId ?? randomUUID(), role: options.role ?? identity.role, at: new Date().toISOString(), text: q.text, intent, bases: result.bases, top: hits, latencyMs: result.latencyMs, tokens: result.tokens })
      return result
    },
    async bindings() { return (await readJsonFile<ProjectStores['config']>(join(stores.projectDir, 'takt.config.json')))?.knowledgeBindings ?? stores.config.knowledgeBindings ?? [] },
    async setBindings(bindings, by, reason) {
      const ids = new Set<string>()
      for (const b of bindings) { const kb = await requireBase(b.baseId); if (kb.scope !== b.scope || ids.has(b.baseId) || !Number.isFinite(b.priority) || typeof b.enabled !== 'boolean') throw new Error('绑定不合法，请检查范围、优先级和重复 ID'); ids.add(b.baseId) }
      await changeKnowledgeConfig(stores, by, reason, 'knowledge.bind', config => { config.knowledgeBindings = bindings }); return bindings
    },
    async evalSets(id) {
      const kb = await requireBase(id), dir = await safePath((await paths(kb)).base, 'evals')
      return Promise.all((await entries(dir)).filter(n => n.endsWith('.jsonl')).map(async n => ({ id: n.slice(0, -6), title: n.slice(0, -6), cases: await readJsonLines<KnowledgeEvalCase>(await safePath(dir, n)) })))
    },
    async upsertCases(id, setId, cases, by) {
      const kb = await requireBase(id), file = await safePath((await paths(kb)).base, `evals/${safeKey(setId)}.jsonl`)
      return knowledgeFileLock(file, async () => {
        const existing = await readJsonLines<KnowledgeEvalCase>(file), map = new Map(existing.map(c => [c.id, c]))
        for (const c of cases) { const cid = safeKey(c.id ?? `case-${randomUUID()}`); if (!c.query?.trim() || !['manual', 'synthetic', 'harvested', 'defect'].includes(c.source) || !['active', 'candidate', 'retired'].includes(c.status) || c.relevant.some(r => ![1, 2, 3].includes(r.grade))) throw new Error('评测用例不合法，请检查问题、来源、状态和相关性'); map.set(cid, { ...c, id: cid, createdAt: map.get(cid)?.createdAt ?? new Date().toISOString(), createdBy: map.get(cid)?.createdBy ?? by }) }
        await auditKnowledge(stores, by, '更新评测用例', `knowledge.evals:${id}:${setId}`)
        const values = [...map.values()]; await writeFileAtomic(file, values.map(c => JSON.stringify(c)).join('\n') + '\n'); return values
      })
    },
    synthesizeCases: (...args) => evaluation.synthesizeCases({ store, chat: opts.chat }, ...args),
    harvestCases: (...args) => evaluation.harvestCases({ store, chat: opts.chat }, ...args),
    runEval: (...args) => evaluation.runEval({ store, chat: opts.chat }, ...args),
    async getEvalRun(id, runId) { const kb = await requireBase(id); return readJsonFile<KnowledgeEvalRun>(await safePath((await paths(kb)).cache, `evals/runs/${safeKey(runId)}.json`)) },
    async evalRuns(id) { const kb = await requireBase(id), dir = await safePath((await paths(kb)).cache, 'evals/runs'); return (await Promise.all((await entries(dir)).filter(n => n.endsWith('.json')).map(n => store.getEvalRun(id, n.slice(0, -5))))).filter((r): r is KnowledgeEvalRun => !!r) },
  }
  return store
}
