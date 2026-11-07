import { createKnowledgeRouter, type KnowledgeIntent, type KnowledgeQuery } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { openStores, loadProjectPlugins, mergeKnowledge } from '../project.js'
import { UsageError } from '../args.js'

const INTENTS = new Set<KnowledgeIntent>([
  'fact',
  'symbol',
  'impact',
  'business',
  'history',
  'schema',
])

export async function runKbQuery(
  project: string | undefined,
  text: string,
  intent: string | undefined,
  json: boolean,
): Promise<void> {
  let parsed: KnowledgeIntent | undefined
  if (intent !== undefined) {
    if (!INTENTS.has(intent as KnowledgeIntent))
      throw new UsageError(`--intent 必须是以下之一：${[...INTENTS].join(', ')}`)
    parsed = intent as KnowledgeIntent
  }
  const stores = await openStores(project)
  const bases = await stores.kb!.list()
  if (bases.length) return runKbCommand(project, 'query', [text], { intent, json })
  const printer = createPrinter(json)
  const sources = mergeKnowledge(stores, await loadProjectPlugins(stores))
  const query: KnowledgeQuery = parsed === undefined ? { text } : { text, intent: parsed }
  const { hits } = await createKnowledgeRouter(sources).query(query)
  if (json) {
    printer.data(hits)
    return
  }
  if (hits.length === 0) {
    printer.text(printer.colors.dim('没有命中。'))
    return
  }
  for (const hit of hits) {
    const level =
      hit.evidenceLevel === undefined ? '' : printer.colors.dim(` [${hit.evidenceLevel}]`)
    printer.text(`${printer.colors.cyan(hit.ref)}${level}  ${hit.title}`)
    printer.text(`  ${hit.snippet.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
}

export interface KbCliOptions {
  kind?: string
  name?: string
  config?: string
  base?: string[] | string
  intent?: string
  top?: number
  wait?: boolean
  force?: boolean
  reason?: string
  off?: boolean
  dryRun?: boolean
  json?: boolean
}
export async function runKbCommand(
  project: string | undefined,
  command: string,
  args: string[],
  options: KbCliOptions = {},
): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const { basename } = await import('node:path')
  const { setTimeout } = await import('node:timers/promises')
  const { randomUUID } = await import('node:crypto')
  const { createProjectSecretResolver } = await import('@taktflow/knowledge')
  const { migrateKnowledge, requireRole, auditKnowledge } = await import('@taktflow/core')
  const { cliActor } = await import('../actor.js')
  const stores = await openStores(project),
    secrets = createProjectSecretResolver(stores),
    kb = stores.kb!
  stores.kb = kb
  const by = cliActor(stores),
    printer = createPrinter(options.json ?? false),
    reason = options.reason ?? `CLI ${command} 知识库`
  requireRole(
    stores,
    by,
    ['ls', 'query'].includes(command) ? 'viewer' : 'maintainer',
    `kb ${command}`,
  )
  const required = (value: string | undefined, label: string) => {
    if (!value?.trim()) throw new UsageError(`缺少 ${label}，请补齐参数`)
    return value
  }
  let result: unknown
  if (command === 'ls') result = await kb.list()
  else if (command === 'new') {
    const config = options.config
      ? (JSON.parse(await readFile(options.config, 'utf8')) as Record<string, unknown>)
      : {}
    const base = await kb.create(
      { kind: required(options.kind, '--kind'), name: required(options.name, '--name'), config },
      by,
      reason,
    )
    await kb.setBindings(
      [
        ...(await kb.bindings()),
        { baseId: base.id, scope: base.scope, enabled: true, priority: 0 },
      ],
      by,
      reason,
    )
    result = base
  } else if (command === 'upload') {
    const id = required(args[0], '知识库 ID')
    if (args.length < 2) throw new UsageError('请提供要上传的文件')
    result = await kb.upload(
      id,
      await Promise.all(
        args
          .slice(1)
          .map(async (path) => ({ path: basename(path), content: await readFile(path) })),
      ),
      by,
    )
  } else if (command === 'build') {
    const id = required(args[0], '知识库 ID'),
      build = await kb.build(id, by, reason)
    result = build
    if (options.wait) {
      let current = build
      while (current.status === 'running') {
        await setTimeout(100)
        current = (await kb.getBuild(id, build.id))!
      }
      result = current
      if (current.status !== 'succeeded')
        throw new Error(`构建 ${current.status}：${current.log.at(-1) ?? '请查看构建日志'}`)
    }
  } else if (command === 'query') {
    if (options.intent && !INTENTS.has(options.intent as KnowledgeIntent))
      throw new UsageError(
        '--intent 不合法，请使用 fact、symbol、impact、business、history 或 schema',
      )
    if (options.top !== undefined && (!Number.isInteger(options.top) || options.top < 0))
      throw new UsageError('--top 必须是非负整数')
    const text = required(args[0], '查询文本'),
      bases = typeof options.base === 'string' ? [options.base] : options.base
    const runId = process.env.TAKT_RUN_ID,
      nodeId = process.env.TAKT_NODE_ID ?? process.env.TAKT_NODE,
      role = process.env.TAKT_ROLE
    const query = {
      text,
      intent: options.intent as KnowledgeIntent | undefined,
      limit: options.top,
      bases,
    }
    const queryId = randomUUID()
    const allowed = process.env.TAKT_KB_BASES
      ? (JSON.parse(process.env.TAKT_KB_BASES) as string[])
      : undefined
    const response = await kb.route(query, {
      bases: allowed?.length ? allowed : undefined,
      caller: {
        queryId,
        runId,
        nodeId,
        requirementId: process.env.TAKT_REQUIREMENT_ID ?? process.env.TAKT_REQ,
        role,
        via: runId || nodeId ? 'tool' : undefined,
      },
    })
    if (runId && nodeId)
      await stores.events.append(runId, {
        type: 'knowledge.query',
        actor: { type: 'system', id: 'kb-cli' },
        nodeId,
        data: {
          query,
          sources: response.bases.map((b) => b.id),
          hits: response.hits.length,
          queryId,
          bases: response.bases,
          top: response.hits.map((h, i) => ({
            baseId: h.baseId,
            ref: h.ref,
            score: h.score ?? 0,
            rank: i + 1,
          })),
          latencyMs: response.latencyMs,
          tokens: response.tokens,
          via: 'tool',
        },
      })
    if (!options.json) {
      if (!response.hits.length) printer.text('没有命中。')
      for (const h of response.hits)
        printer.text(`${h.ref} [${h.baseId}@v${h.version}] ${h.title}\n${h.snippet}`)
      return
    }
    result = response
  } else if (command === 'publish') {
    if (options.force && !options.reason?.trim()) throw new UsageError('强制发布必须提供 --reason')
    result = await kb.publish(required(args[0], '知识库 ID'), { by, reason, force: options.force })
  } else if (command === 'bind') {
    const id = required(args[0], '知识库 ID'),
      base = await kb.get(id)
    if (!base) throw new UsageError('知识库不存在，请检查 ID')
    const bindings = await kb.bindings(),
      previous = bindings.find((b) => b.baseId === id)
    result = await kb.setBindings(
      [
        ...bindings.filter((b) => b.baseId !== id),
        {
          baseId: id,
          scope: base.scope,
          priority: previous?.priority ?? 0,
          ...previous,
          enabled: !options.off,
        },
      ],
      by,
      reason,
    )
  } else if (command === 'migrate')
    result = await migrateKnowledge(stores, { dryRun: options.dryRun, reason }, by)
  else if (command === 'secret' && args[0] === 'set') {
    const name = required(args[1], '密钥名称'),
      chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const value = Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '')
    if (!value) throw new UsageError('密钥为空，请从 stdin 输入')
    await auditKnowledge(stores, by, reason, `knowledge.secret:${name}`)
    await secrets.set(name, value)
    result = { name }
  } else
    throw new UsageError(
      '未知 kb 子命令，请使用 ls、new、upload、build、query、publish、bind、migrate 或 secret set',
    )
  if (options.json) printer.data(result)
  else if (Array.isArray(result))
    for (const item of result)
      printer.text(
        typeof item === 'object' && item !== null && 'name' in item
          ? `${item.id}  ${item.name}  ${item.status ?? ''} v${item.version ?? 0}`
          : JSON.stringify(item),
      )
  else printer.text(JSON.stringify(result, null, 2))
}
