import type { Risk, RiskStateRequest, StewardPrefs } from '../api.js'
import { computeRisks } from '../insights/risks.js'
import { type StewardDeps, timestamp, StewardError } from './contracts.js'
import { StewardStore } from './store.js'

const riskCache = new Map<
  string,
  { until: number; pending: Promise<Awaited<ReturnType<typeof computeRisks>>> }
>()
interface StoredRisk extends Risk {
  lastNotifiedAt?: string
}
export function isQuiet(prefs: StewardPrefs, now: Date): boolean {
  if (!prefs.quietHours) return false
  const minute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    { from, to } = prefs.quietHours
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to
}
export async function refreshRisks(
  deps: StewardDeps,
  store: StewardStore,
  cacheForMs = 0,
): Promise<Risk[]> {
  const spaces = await deps.spaces(),
    now = deps.now?.() ?? new Date(),
    at = now.toISOString()
  const computed = (
    await Promise.all(
      spaces
        .filter((space) => !space.archived)
        .map(async (summary) => {
          const space = await deps.open(summary.id)
          const key = space.stores.projectDir
          let cached = cacheForMs ? riskCache.get(key) : undefined
          if (!cached || cached.until <= now.getTime()) {
            const pending = (async () => [
              ...(await computeRisks(space.stores, space.id, now)),
              ...((await deps.extraRisks?.(space)) ?? []),
            ])()
            cached = { until: now.getTime() + cacheForMs, pending }
            if (cacheForMs) {
              if (riskCache.size >= 1000) riskCache.delete(riskCache.keys().next().value!)
              riskCache.set(key, cached)
              void pending.catch(() => riskCache.delete(key))
            }
          }
          return cached.pending
        }),
    )
  ).flat()
  return store.serial(async () => {
    const previous = (await store.read<Record<string, StoredRisk>>('risks.json')) ?? {},
      prefs = await store.prefs()
    const next: Record<string, StoredRisk> = {},
      muted = new Set(prefs.mutedSpaces),
      quiet = isQuiet(prefs, now)
    const unique = new Map<string, (typeof computed)[number]>()
    for (const risk of computed)
      if (!unique.has(risk.key) || risk.level === 'high') unique.set(risk.key, risk)
    for (const current of unique.values()) {
      const old = previous[current.key]
      const state =
        !old ||
        old.state === 'resolved' ||
        (old.state === 'snoozed' && Date.parse(old.snoozedUntil ?? '') <= now.getTime())
          ? 'open'
          : old.state
      const risk: StoredRisk = {
        ...current,
        state,
        firstSeenAt: old?.firstSeenAt ?? at,
        lastSeenAt: at,
        snoozedUntil: old?.snoozedUntil,
        notifiedLevel: old?.notifiedLevel,
        lastNotifiedAt: old?.lastNotifiedAt,
      }
      const escalated = old?.notifiedLevel === 'medium' && risk.level === 'high'
      if (
        state === 'open' &&
        !muted.has(risk.spaceId) &&
        !quiet &&
        (!old?.notifiedLevel ||
          old.state === 'resolved' ||
          old.state === 'snoozed' ||
          escalated ||
          now.getTime() - Date.parse(old.lastNotifiedAt ?? '') >= 86400000)
      ) {
        risk.notifiedLevel = risk.level
        risk.lastNotifiedAt = at
        await store.feed({ type: 'risk', at, risk, change: escalated ? 'escalated' : 'new' })
        await store.append('metrics.jsonl', {
          at,
          feature: 'steward.digest',
          type: 'risk.notified',
          detail: { key: risk.key, kind: risk.kind },
        })
      }
      next[risk.key] = risk
    }
    const visible = new Set(spaces.map((space) => space.id))
    for (const old of Object.values(previous))
      if (!next[old.key] && visible.has(old.spaceId)) {
        next[old.key] = { ...old, state: 'resolved' }
        if (old.state !== 'resolved')
          await store.append('metrics.jsonl', {
            at,
            feature: 'steward.digest',
            type: 'risk.resolved',
            ms: now.getTime() - Date.parse(old.firstSeenAt),
            detail: { key: old.key, kind: old.kind },
          })
        if (old.state !== 'resolved' && !muted.has(old.spaceId) && !quiet)
          await store.feed({ type: 'risk', at, risk: next[old.key]!, change: 'resolved' })
      }
    await store.write('risks.json', next)
    return Object.values(next)
  })
}
export async function setRiskState(
  deps: StewardDeps,
  store: StewardStore,
  key: string,
  input: RiskStateRequest,
): Promise<Risk> {
  return store.serial(async () => {
    if (!['open', 'snoozed', 'ignored'].includes(input.state))
      throw new StewardError(400, '风险状态不合法，请重新选择')
    if (
      input.state === 'snoozed' &&
      (!input.until ||
        !Number.isFinite(Date.parse(input.until)) ||
        Date.parse(input.until) <= Date.parse(timestamp(deps)))
    )
      throw new StewardError(400, '稍后提醒需要一个未来时间，请重新选择')
    const risks = (await store.read<Record<string, StoredRisk>>('risks.json')) ?? {},
      risk = risks[key]
    if (!risk) throw new StewardError(404, '风险不存在，请刷新列表')
    risk.state = input.state
    risk.snoozedUntil = input.state === 'snoozed' ? input.until : undefined
    await store.write('risks.json', risks)
    await store.append('metrics.jsonl', {
      at: timestamp(deps),
      feature: 'steward.digest',
      type: input.state,
      detail: { key, kind: risk.kind },
      reason: input.reason ?? '用户调整提醒',
      ms: Date.parse(timestamp(deps)) - Date.parse(risk.firstSeenAt),
    })
    return risk
  })
}
