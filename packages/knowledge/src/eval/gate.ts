import type { Actor, KnowledgeEvalVariant } from '@taktflow/core'
import type { EvalDeps } from './contracts.js'
import { finishRun, prepareRun } from './run.js'

export async function publishGate(
  deps: EvalDeps,
  id: string,
  input: { version?: number; by: Actor; reason: string; force?: boolean },
): Promise<{ pass: boolean; reasons: string[] }> {
  if (input.force && !input.reason?.trim()) throw new Error('强制发布必须提供 reason，请填写原因')
  const sets = await deps.store.evalSets(id)
  // 不同评测集可能复用用例 ID，门槛内使用带集合名的身份，避免互相覆盖。
  const cases = sets.flatMap((evalCase) =>
    evalCase.cases
      .filter((evalCase2) => evalCase2.status === 'active')
      .map((evalCase3) => ({ ...evalCase3, id: `${evalCase.id}/${evalCase3.id}` })),
  )
  if (!cases.length) return { pass: true, reasons: ['无评测用例，首次发布'] }
  const base = await deps.store.get(id)
  if (!base) throw new Error('知识库不存在，请刷新后重试')
  const variants: KnowledgeEvalVariant[] = [
    ...(base.version ? [{ id: 'baseline', label: '已发布版本', version: base.version }] : []),
    {
      id: 'candidate',
      label: '候选版本',
      version: input.version ?? base.candidateVersion ?? base.version,
    },
  ]
  const run = await prepareRun(deps, id, { setId: 'publish-gate', variants, by: input.by })
  await deps.saveRun(run)
  await finishRun(deps, run, cases)
  const reasons: string[] = []
  if (run.status === 'failed') reasons.push(run.error!)
  else {
    if (run.error) reasons.push(run.error)
    if ((run.comparison?.recall10Delta ?? 0) < -0.05 - 1e-12)
      reasons.push('Recall@10 下降超过 5 个百分点，请优化检索后重新评测')
    if (run.comparison?.verdict === 'worse') reasons.push('候选版本显著退化，请检查逐用例比较结果')
    const failed = cases.filter(
      (chunk) =>
        chunk.source === 'defect' &&
        !run.perCase.some(
          (record) =>
            record.variant === 'candidate' && record.caseId === chunk.id && record.found.length > 0,
        ),
    )
    if (failed.length)
      reasons.push(
        `缺陷回归用例未在 topK 内命中：${failed.map((chunk2) => chunk2.id).join('、')}，请修复后重试`,
      )
  }
  if (input.force)
    await deps.audit(
      input.by,
      input.reason,
      `knowledge.publish.force:${id}:${run.id}:${JSON.stringify(reasons)}`,
    )
  return { pass: !reasons.length, reasons }
}
