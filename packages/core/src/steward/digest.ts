import { randomUUID } from 'node:crypto'
import { sha256 } from '../util/hash.js'
import type { Digest, StewardFeedItem } from '../api.js'
import type { EventPayloads } from '../types.js'
import { type StewardDeps, timestamp, StewardError } from './contracts.js'
import { StewardStore } from './store.js'
import { refreshRisks, isQuiet } from './risks.js'
import { stewardLinks } from './links.js'

interface Seen {
  at: string
  /** 空间总览横幅各自标的已读（docs/design/22 §1.6）：只看过一个空间，不算看过别的空间。 */
  spaces?: Record<string, string>
}
/** spaceId：只汇报这个空间（空间总览的「自上次以来」），已读也只记在这个空间上。 */
export async function buildDigest(
  deps: StewardDeps,
  store: StewardStore,
  since?: string,
  markSeen = true,
  peek = false,
  spaceId?: string,
): Promise<Digest> {
  const at = timestamp(deps),
    prefs = await store.prefs(),
    seen = await store.read<Seen>('seen.json')
  const spaceSeen = spaceId ? seen?.spaces?.[spaceId] : undefined
  since ??= spaceSeen && (!seen?.at || spaceSeen > seen.at) ? spaceSeen : seen?.at
  if (since && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.parse(at)))
    throw new StewardError(400, '汇报起始时间不合法，请选择过去的时间')
  const from = since ? Date.parse(since) : 0,
    until = Date.parse(at)
  const inWindow = (date: string) => Date.parse(date) > from && Date.parse(date) <= until
  const spaces = (await deps.spaces()).filter(
    (space) =>
      !space.archived &&
      (!spaceId || space.id === spaceId) &&
      !prefs.mutedSpaces?.includes(space.id) &&
      (!prefs.watchedSpaces?.length || prefs.watchedSpaces.includes(space.id)),
  )
  const digest: Digest = {
    id: peek ? '' : randomUUID(),
    at,
    since,
    summary: '',
    attention: [],
    risks: [],
    progress: [],
    metrics: [],
  }
  const metricChanges: Array<{ spaceId: string; label: string; value: string; delta?: string; ratio: number }> = []
  const visible = new Set(spaces.map((s) => s.id))
  const risks = peek
    ? Object.values(
        (await store.read<Record<string, import('../api.js').Risk>>('risks.json')) ?? {},
      )
    : await refreshRisks(deps, store, 60000)
  digest.risks = risks.filter(
    (risk) => visible.has(risk.spaceId) && risk.state === 'open' && inWindow(risk.firstSeenAt),
  )
  for (const summary of spaces) {
    const { stores } = await deps.open(summary.id),
      requirements = await stores.workspaces.listRequirements(),
      runs = await stores.runs.list()
    for (const item of await stores.attention.list({ pending: true }))
      if (Date.parse(item.createdAt) <= until) {
        const title =
          requirements.find((req) => req.id === item.requirementId)?.title ?? item.requirementId
        digest.attention.push({
          spaceId: summary.id,
          requirementId: item.requirementId,
          requirementTitle: title,
          requestId: item.requestId,
          ask: `${item.ask}（已等待 ${Math.max(0, Math.floor((until - Date.parse(item.createdAt)) / 60000))} 分钟）`,
          since: item.createdAt,
          href: stewardLinks.attention(summary.id),
        })
      }
    for (const req of requirements) {
      if (inWindow(req.createdAt))
        digest.progress.push({
          spaceId: summary.id,
          requirementId: req.id,
          title: req.title,
          kind: 'created',
          at: req.createdAt,
          href: stewardLinks.requirement(summary.id, req.id),
        })
      if (['delivered', 'blocked'].includes(req.status) && inWindow(req.updatedAt))
        digest.progress.push({
          spaceId: summary.id,
          requirementId: req.id,
          title: req.title,
          kind: req.status as 'delivered' | 'blocked',
          at: req.updatedAt,
          href: stewardLinks.requirement(summary.id, req.id),
        })
    }
    let tokens = 0,
      previousTokens = 0,
      active = false
    for (const run of runs) {
      const events = await stores.events.read(run.runId),
        snapshot = await stores.runs.getWorkflow(run.runId)
      const stages = new Map((snapshot?.nodes ?? []).map((node) => [node.id, node.stage]))
      for (const event of events) {
        if (event.type === 'harness.usage') {
          const usage = event.data as EventPayloads['harness.usage'],
            n = usage.inputTokens + usage.outputTokens
          if (inWindow(event.ts)) tokens += n
          else if (Date.parse(event.ts) > from - (until - from) && Date.parse(event.ts) <= from)
            previousTokens += n
        }
        if (!inWindow(event.ts)) continue
        if (event.type === 'run.started' || event.type.startsWith('node.')) active = true
        const kind =
          event.type === 'run.started'
            ? 'started'
            : event.type === 'run.finished' &&
                (event.data as EventPayloads['run.finished']).status === 'failed'
              ? 'failed'
              : event.type === 'node.started' && stages.get(event.nodeId ?? '')
                ? 'stage'
                : undefined
        if (kind)
          digest.progress.push({
            spaceId: summary.id,
            requirementId: run.requirementId,
            title:
              requirements.find((req) => req.id === run.requirementId)?.title ?? run.requirementId,
            kind,
            at: event.ts,
            to: kind === 'stage' ? stages.get(event.nodeId!) : undefined,
            href: stewardLinks.run(summary.id, run.runId, event.nodeId),
          })
      }
    }
    const delta = tokens - previousTokens,
      ratio = previousTokens ? Math.abs(delta) / previousTokens : tokens ? 1 : 0
    if (active && since && Math.abs(delta) >= 5000 && ratio >= 0.2)
      metricChanges.push({
        spaceId: summary.id,
        label: delta >= 0 ? 'Token 用量比上个窗口上涨' : 'Token 用量比上个窗口下降',
        value: String(tokens),
        delta: String(delta),
        ratio,
      })
  }
  digest.metrics = metricChanges
    .sort((a, b) => b.ratio - a.ratio || Math.abs(Number(b.delta)) - Math.abs(Number(a.delta)))
    .slice(0, 3)
    .map(({ ratio: _ratio, ...item }) => item)
  const progress = new Map<string, Digest['progress'][number]>()
  const priority = { created: 0, started: 1, stage: 2, blocked: 3, failed: 4, delivered: 5 }
  for (const item of digest.progress.sort((a, b) => b.at.localeCompare(a.at) || priority[b.kind] - priority[a.kind])) {
    const key = JSON.stringify([item.spaceId, item.requirementId]), latest = progress.get(key)
    if (latest) latest.more = (latest.more ?? 0) + 1
    else progress.set(key, item)
  }
  digest.progress = [...progress.values()]
  digest.summary = `有 ${digest.attention.length} 条待办、${digest.risks.length} 条新风险和 ${digest.progress.length} 项进展。`
  if (peek)
    digest.id = sha256(
      JSON.stringify({
        since,
        attention: digest.attention.map((item) => item.requestId),
        risks: digest.risks.map((risk) => risk.key),
        progress: digest.progress,
        metrics: digest.metrics,
      }),
    )
  if (deps.chat && !peek) {
    const response = await deps.chat({
      model: prefs.harness?.model ?? '',
      messages: [
        { role: 'system', content: '只根据下列列表写两句摘要，不增加任何数字或事实。' },
        { role: 'user', content: JSON.stringify(digest) },
      ],
    })
    if (response.message.content.trim())
      digest.summary = response.message.content
        .split(/(?<=[。！？.!?])\s*/u)
        .slice(0, 2)
        .join('')
  }
  if (markSeen && !peek) {
    await store.write('seen.json', spaceId ? { ...seen, spaces: { ...seen?.spaces, [spaceId]: at } } : { at })
    await store.append('metrics.jsonl', { at, feature: 'steward.digest', type: 'digest.open', ...(spaceId ? { spaceId } : {}) })
  }
  return digest
}
export function startDigestScheduler(
  deps: StewardDeps,
  stores: () => Iterable<StewardStore>,
  onError: (error: unknown) => void = () => {},
): { tick(): Promise<void>; close(): void } {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const now = deps.now?.() ?? new Date(),
        day = now.getDay()
      for (const store of stores()) {
        await refreshRisks(deps, store, 60000)
        const prefs = await store.prefs(),
          hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        if (day === 0 || day === 6 || !prefs.digestTimes.includes(hm) || isQuiet(prefs, now))
          continue
        await store.serial(async () => {
          const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}/${hm}`
          const sent = (await store.read<string[]>('scheduled.json')) ?? []
          if (sent.includes(key)) return
          const digest = await buildDigest(deps, store, undefined, false)
          await store.feed({ type: 'digest', at: digest.at, digest })
          await store.write('scheduled.json', [...sent.slice(-100), key])
        })
      }
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => {
    void tick().catch(onError)
  }, 60000)
  timer.unref()
  return { tick, close: () => clearInterval(timer) }
}
export async function unreadFeed(store: StewardStore): Promise<number> {
  const seen = (await store.read<{ at: string }>('seen.json'))?.at ?? ''
  return (await store.lines<StewardFeedItem>('feed.jsonl')).filter((item) => item.at > seen).length
}
