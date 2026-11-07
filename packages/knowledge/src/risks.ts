import type { ProjectStores, Risk } from '@taktflow/core'
import { readStaleSince } from './store/stale.js'
import { readQueries } from './store/query-log.js'

export async function knowledgeRisks(
  space: { id: string; stores: ProjectStores },
  now = new Date(),
): Promise<Array<Omit<Risk, 'state'>>> {
  const store = space.stores.kb
  if (!store) return []
  const risks: Array<Omit<Risk, 'state'>> = []
  const at = now.toISOString()
  const time = now.getTime()
  const queries = (await readQueries(space.stores)).filter(
    (query2) =>
      query2.type !== 'used' &&
      query2.via !== 'eval' &&
      Date.parse(query2.at) >= time - 7 * 86400000 &&
      Date.parse(query2.at) <= time,
  )
  for (const base of await store.list()) {
    const href = `/s/${encodeURIComponent(space.id)}/knowledge/${encodeURIComponent(base.id)}`
    const add = (rule: string, title: string, detail: string, firstSeenAt = at) =>
      risks.push({
        key: `knowledge:${space.id}//${base.id}/${rule}`,
        kind: 'knowledge',
        level: 'medium',
        spaceId: space.id,
        title,
        detail,
        firstSeenAt,
        lastSeenAt: at,
        evidence: [{ label: base.name, href }],
        actions: [{ label: '让管家处理', ask: `请检查知识库 ${base.name}：${detail}`, href }],
      })
    const latest = (await store.builds(base.id)).sort(
      (build2, build3) => build3.version - build2.version,
    )[0]
    if (latest?.status === 'failed')
      add(
        'build',
        `${base.name} 构建失败`,
        latest.log.at(-1) ?? '请检查构建日志后重新构建',
        latest.endedAt ?? latest.startedAt,
      )
    const staleSince =
      base.status === 'stale' ? await readStaleSince(space.stores, base) : undefined
    if (staleSince && time - Date.parse(staleSince) > 3 * 86400000)
      add('stale', `${base.name} 已过期超过 3 天`, '请重新构建并评测后发布', staleSince)
    const runs = (await store.evalRuns(base.id))
      .filter((record) => record.status === 'done')
      .sort((left, right) =>
        (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt),
      )
    const current = runs[0]
    const previous = runs[1]
    const metric = (run: NonNullable<typeof current>) => {
      const variant = run.variants.at(-1)
      return variant ? run.metrics[variant.id] : undefined
    }
    if (
      current &&
      previous &&
      metric(current)?.n &&
      metric(previous)?.n &&
      metric(previous)!.recall10 - metric(current)!.recall10 > 0.05 + 1e-12
    )
      add(
        'recall',
        `${base.name} 召回率下降`,
        'Recall@10 比上次下降超过 5 个百分点，请检查失败查询',
        current.endedAt ?? current.startedAt,
      )
    const rows = queries.filter((query3) => query3.bases.some((right2) => right2.id === base.id))
    const empty = rows.filter((query4) => !query4.top.some((hit) => hit.baseId === base.id)).length
    if (rows.length >= 20 && empty / rows.length > 0.3)
      add(
        'empty',
        `${base.name} 无结果率过高`,
        `最近 7 天 ${rows.length} 次查询中 ${empty} 次无结果，请补充文档或调整检索参数`,
      )
  }
  return risks
}
