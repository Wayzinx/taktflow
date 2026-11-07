import { randomUUID } from 'node:crypto'
import {
  type KnowledgeEvalCase,
  type KnowledgeEvalRun,
  type KnowledgeEvalVariant,
  type KnowledgeStore,
} from '@taktflow/core'
import { safeKey } from '../store/files.js'
import type { EvalDeps } from './contracts.js'
import { compare, diagnose, metrics, recall, type Observation } from './metrics.js'

export async function evaluate(
  deps: EvalDeps,
  run: KnowledgeEvalRun,
  cases: KnowledgeEvalCase[],
): Promise<void> {
  const base = await deps.store.get(run.baseId)
  if (!base) throw new Error('知识库不存在，请刷新后重试')
  const observations = new Map<string, Observation[]>()
  for (const variant of run.variants) {
    const version = variant.version!
    const snapshot = await deps.snapshot(run.baseId, version)
    const retrieval = { ...snapshot.base.retrieval, ...variant.retrieval }
    const indexed = new Set(snapshot.chunks.map((chunk) => chunk.ref))
    const rows: Observation[] = []
    for (const test of cases) {
      const start = Date.now()
      let row: Observation
      let ranked: Observation['hits'] = []
      try {
        const result = await deps.query(
          run.baseId,
          { text: test.query, intent: test.intent },
          version,
          retrieval,
        )
        ranked = result.hits
        row = {
          test,
          hits: result.hits,
          topK: retrieval.topK,
          latencyMs: result.latencyMs,
          tokens: result.tokens,
          executed: result.executed,
        }
        // 诊断搜索不改变实际查询的指标，也不重复执行 SQL 或 HTTP 请求。
        if (
          !result.executed &&
          !result.hits.some((hit) => test.relevant.some((record) => record.ref === hit.ref))
        ) {
          const probe = await deps.query(
            run.baseId,
            { text: test.query, intent: test.intent },
            version,
            { ...retrieval, topK: 50, budgetTokens: Number.MAX_SAFE_INTEGER },
          )
          ranked = probe.hits
        }
      } catch (error) {
        const execution =
          base.kind === 'database' && /^\s*(select|with|show|describe|explain)\b/i.test(test.query)
            ? 'sql'
            : base.kind === 'api' && /^(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(test.query.trim())
              ? 'http'
              : undefined
        if (!execution) throw error
        row = {
          test,
          hits: [],
          topK: retrieval.topK,
          latencyMs: Date.now() - start,
          tokens: 0,
          executed: { kind: execution, text: test.query },
          failed: true,
        }
        run.error = '部分数据库或接口调用失败，请检查连接、权限及服务状态后重试'
      }
      rows.push(row)
      const relevant = new Set(test.relevant.map((record2) => record2.ref))
      const found = [
        ...new Set(row.hits.filter((hit2) => relevant.has(hit2.ref)).map((hit3) => hit3.ref)),
      ]
      const first = ranked.findIndex((hit4) => relevant.has(hit4.ref))
      run.perCase.push({
        caseId: test.id,
        variant: variant.id,
        firstRelevantRank: first < 0 ? undefined : first + 1,
        found,
        missed: [...relevant].filter((ref) => !found.includes(ref)),
        diagnosis: found.length ? 'ok' : diagnose(test, ranked, 0, indexed),
        latencyMs: row.latencyMs,
      })
      run.metrics[variant.id] = metrics(rows, base.kind)
      await deps.saveRun(run)
    }
    observations.set(variant.id, rows)
    run.metrics[variant.id] = metrics(rows, base.kind)
  }
  if (run.variants.length === 2) {
    const [baseline, candidate] = run.variants as [KnowledgeEvalVariant, KnowledgeEvalVariant]
    run.comparison = compare(
      baseline.id,
      candidate.id,
      observations.get(baseline.id)!.map((record3) => recall(record3.test, record3.hits, 10)),
      observations.get(candidate.id)!.map((record4) => recall(record4.test, record4.hits, 10)),
    )
  }
}
export async function prepareRun(
  deps: EvalDeps,
  id: string,
  input: Parameters<KnowledgeStore['runEval']>[1],
): Promise<KnowledgeEvalRun> {
  safeKey(id)
  safeKey(input.setId)
  if (
    !input.variants.length ||
    new Set(input.variants.map((value) => value.id)).size !== input.variants.length
  )
    throw new Error('请提供至少一个变体，且变体 ID 不能重复')
  const base = await deps.store.get(id)
  if (!base) throw new Error('知识库不存在，请刷新后重试')
  const variants = structuredClone(input.variants)
  for (const variant of variants) {
    safeKey(variant.id)
    variant.version ??= base.candidateVersion ?? base.version
    if (!Number.isInteger(variant.version) || variant.version < 1)
      throw new Error('评测版本不合法，请先构建知识库')
    const snapshot = await deps.snapshot(id, variant.version)
    const record5 = { ...snapshot.base.retrieval, ...variant.retrieval }
    if (
      !Number.isInteger(record5.topK) ||
      record5.topK < 0 ||
      !Number.isInteger(record5.budgetTokens) ||
      record5.budgetTokens < 0
    )
      throw new Error('评测检索参数不合法，请使用非负整数 topK 和预算')
  }
  return {
    id: `eval-${randomUUID()}`,
    baseId: id,
    setId: input.setId,
    variants,
    by: input.by,
    status: 'running',
    startedAt: new Date().toISOString(),
    metrics: {},
    perCase: [],
  }
}
export async function finishRun(
  deps: EvalDeps,
  run: KnowledgeEvalRun,
  cases: KnowledgeEvalCase[],
): Promise<void> {
  try {
    await evaluate(deps, run, cases)
    run.status = 'done'
  } catch (error) {
    run.status = 'failed'
    run.error = `评测失败，请检查配置后重试：${error instanceof Error ? error.message : String(error)}`
  }
  run.endedAt = new Date().toISOString()
  await deps.saveRun(run)
}
export async function runEval(
  deps: EvalDeps,
  id: string,
  input: Parameters<KnowledgeStore['runEval']>[1],
): ReturnType<KnowledgeStore['runEval']> {
  safeKey(input.setId)
  const set = (await deps.store.evalSets(id)).find((evalCase) => evalCase.id === input.setId)
  if (!set) throw new Error('评测集不存在，请先添加用例')
  const cases = structuredClone(set.cases.filter((evalCase2) => evalCase2.status === 'active'))
  const run = await prepareRun(deps, id, input)
  await deps.audit(input.by, '运行知识库评测', `knowledge.eval:${id}:${run.id}`)
  await deps.saveRun(run)
  const response = structuredClone(run)
  // 返回运行 ID 后继续执行；终态与逐用例结果都写入同一个运行文件。
  void finishRun(deps, run, cases).catch((error) => {
    console.error(
      '知识库评测结果写入失败，请检查存储目录',
      error instanceof Error ? error.message : String(error),
    )
  })
  return response
}
