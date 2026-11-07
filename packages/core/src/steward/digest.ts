import { randomUUID } from 'node:crypto'
import type { Digest, StewardFeedItem } from '../api.js'
import type { EventPayloads } from '../types.js'
import { type StewardDeps, timestamp, StewardError } from './contracts.js'
import { StewardStore } from './store.js'
import { refreshRisks, isQuiet } from './risks.js'
import { stewardLinks } from './links.js'

export async function buildDigest(deps: StewardDeps, store: StewardStore, since?: string, markSeen = true): Promise<Digest> {
  const at = timestamp(deps), prefs = await store.prefs()
  since ??= (await store.read<{ at: string }>('seen.json'))?.at
  if (since && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.parse(at))) throw new StewardError(400, '汇报起始时间不合法，请选择过去的时间')
  const from = since ? Date.parse(since) : 0, until = Date.parse(at)
  const inWindow = (date: string) => Date.parse(date) > from && Date.parse(date) <= until
  const spaces = (await deps.spaces()).filter((space) => !space.archived && !prefs.mutedSpaces?.includes(space.id) && (!prefs.watchedSpaces?.length || prefs.watchedSpaces.includes(space.id)))
  const digest: Digest = { id: randomUUID(), at, since, summary: '', attention: [], risks: [], progress: [], metrics: [] }
  const visible = new Set(spaces.map((s) => s.id))
  digest.risks = (await refreshRisks(deps, store)).filter((risk) => visible.has(risk.spaceId) && risk.state === 'open' && inWindow(risk.firstSeenAt))
  for (const summary of spaces) {
    const { stores } = await deps.open(summary.id), requirements = await stores.workspaces.listRequirements(), runs = await stores.runs.list()
    for (const item of await stores.attention.list({ pending: true })) if (Date.parse(item.createdAt) <= until) {
      const title = requirements.find((req) => req.id === item.requirementId)?.title ?? item.requirementId
      digest.attention.push({ spaceId: summary.id, requirementId: item.requirementId, requirementTitle: title, requestId: item.requestId,
        ask: `${item.ask}（已等待 ${Math.max(0, Math.floor((until - Date.parse(item.createdAt)) / 60000))} 分钟）`, since: item.createdAt, href: stewardLinks.attention(summary.id) })
    }
    for (const req of requirements) {
      if (inWindow(req.createdAt)) digest.progress.push({ spaceId: summary.id, requirementId: req.id, title: req.title, kind: 'created', at: req.createdAt, href: stewardLinks.requirement(summary.id, req.id) })
      if (['delivered', 'blocked'].includes(req.status) && inWindow(req.updatedAt)) digest.progress.push({ spaceId: summary.id, requirementId: req.id, title: req.title, kind: req.status as 'delivered' | 'blocked', at: req.updatedAt, href: stewardLinks.requirement(summary.id, req.id) })
    }
    let tokens = 0, previousTokens = 0
    for (const run of runs) {
      const events = await stores.events.read(run.runId), snapshot = await stores.runs.getWorkflow(run.runId)
      const stages = new Map((snapshot?.nodes ?? []).map((node) => [node.id, node.stage]))
      for (const event of events) {
        if (event.type === 'harness.usage') {
          const usage = event.data as EventPayloads['harness.usage'], n = usage.inputTokens + usage.outputTokens
          if (inWindow(event.ts)) tokens += n
          else if (Date.parse(event.ts) > from - (until - from) && Date.parse(event.ts) <= from) previousTokens += n
        }
        if (!inWindow(event.ts)) continue
        const kind = event.type === 'run.started' ? 'started' : event.type === 'run.finished' && (event.data as EventPayloads['run.finished']).status === 'failed' ? 'failed'
          : event.type === 'node.started' && stages.get(event.nodeId ?? '') ? 'stage' : undefined
        if (kind) digest.progress.push({ spaceId: summary.id, requirementId: run.requirementId, title: requirements.find((req) => req.id === run.requirementId)?.title ?? run.requirementId,
          kind, at: event.ts, to: kind === 'stage' ? stages.get(event.nodeId!) : undefined, href: stewardLinks.run(summary.id, run.runId, event.nodeId) })
      }
    }
    digest.metrics!.push({ spaceId: summary.id, label: 'Token 用量', value: String(tokens), delta: since ? String(tokens - previousTokens) : undefined })
  }
  digest.progress = [...new Map(digest.progress.map((p) => [`${p.spaceId}/${p.requirementId}/${p.kind}/${p.to ?? p.at}`, p])).values()].sort((a, b) => a.at.localeCompare(b.at))
  digest.summary = `有 ${digest.attention.length} 条待办、${digest.risks.length} 条新风险和 ${digest.progress.length} 项进展。`
  if (deps.chat) {
    const response = await deps.chat({ model: prefs.harness?.model ?? '', messages: [{ role: 'system', content: '只根据下列列表写两句摘要，不增加任何数字或事实。' }, { role: 'user', content: JSON.stringify(digest) }] })
    if (response.message.content.trim()) digest.summary = response.message.content.split(/(?<=[。！？.!?])\s*/u).slice(0, 2).join('')
  }
  if (markSeen) { await store.write('seen.json', { at }); await store.append('metrics.jsonl', { at, feature: 'steward.digest', type: 'digest.open' }) }
  return digest
}
export function startDigestScheduler(deps: StewardDeps, stores: () => Iterable<StewardStore>, onError: (error: unknown) => void = () => {}): { tick(): Promise<void>; close(): void } {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const now = deps.now?.() ?? new Date(), day = now.getDay()
      for (const store of stores()) {
        await refreshRisks(deps, store)
        const prefs = await store.prefs(), hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        if (day === 0 || day === 6 || !prefs.digestTimes.includes(hm) || isQuiet(prefs, now)) continue
        await store.serial(async () => {
          const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}/${hm}`
          const sent = await store.read<string[]>('scheduled.json') ?? []
          if (sent.includes(key)) return
          const digest = await buildDigest(deps, store, undefined, false)
          await store.feed({ type: 'digest', at: digest.at, digest })
          await store.write('scheduled.json', [...sent.slice(-100), key])
        })
      }
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick().catch(onError) }, 60000); timer.unref()
  return { tick, close: () => clearInterval(timer) }
}
export async function unreadFeed(store: StewardStore): Promise<number> {
  const seen = (await store.read<{ at: string }>('seen.json'))?.at ?? ''
  return (await store.lines<StewardFeedItem>('feed.jsonl')).filter((item) => item.at > seen).length
}
