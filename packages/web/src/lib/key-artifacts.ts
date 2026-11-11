import type { ArtifactKind, ArtifactRecord } from '@taktflow/core'

/**
 * 重点产物：人要重点看的那几份——最近一轮运行产出的需求说明、方案、测试计划、改动说明与代码改动、
 * 判决、报告、评审结论（summary.md），以及 AI 代人作答 / 准出的决定。
 * 其余是过程记录（自测证据、评审轮次 JSON、旧轮次的文档），需要细节时再展开看。
 *
 * 按“最近一轮”而不是全部历史：同一需求跑过多轮时（真实需求跑了 15 次、攒了 96 个产物），
 * 旧轮次的 PRD / 改动说明只是留档，混在一起反而找不到这一轮该看的。
 */
const KEY_KINDS = new Set<ArtifactKind>(['spec', 'design', 'test-plan', 'task', 'code-change', 'verdict', 'report', 'knowledge'])

/** 这类产物是不是给人读的结论 / 交付物（不看是哪一轮）。 */
export function isKeyKind(record: ArtifactRecord): boolean {
  // 机读记录：自测结果、评审轮次、集成结果、契约
  if (record.mediaType.includes('json')) return false
  if (KEY_KINDS.has(record.kind)) return true
  if (record.kind === 'review') return /(^|\/)summary\.md$/.test(record.path)
  if (record.kind === 'decision') return record.path.startsWith('decisions/auto-answers/')
  return false
}

/**
 * 重点产物的路径，以及它们来自哪一轮运行（最近一次产出重点类产物的运行）。
 * 还没有运行产出过时（例如只有人放进来的文档），重点类产物都算。
 */
export function keyArtifacts(records: readonly ArtifactRecord[]): { runId?: string; paths: Set<string> } {
  let latest: { runId: string; at: string } | undefined
  for (const record of records) {
    if (!isKeyKind(record)) continue
    for (const version of record.versions) {
      const runId = version.producedBy?.runId
      if (runId && (!latest || version.createdAt > latest.at)) latest = { runId, at: version.createdAt }
    }
  }
  const runId = latest?.runId
  const paths = new Set(
    records
      .filter((record) => isKeyKind(record) && (runId === undefined || record.versions.some((version) => version.producedBy?.runId === runId)))
      .map((record) => record.path),
  )
  return runId === undefined ? { paths } : { runId, paths }
}
