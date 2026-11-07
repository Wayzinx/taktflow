import type {
  KnowledgeEvalCase,
  KnowledgeEvalMetrics,
  KnowledgeEvalRun,
  KnowledgeExecution,
  KnowledgeHit,
  KnowledgeMissDiagnosis,
} from '@taktflow/core'

export interface Observation {
  test: KnowledgeEvalCase
  hits: KnowledgeHit[]
  topK: number
  latencyMs: number
  tokens: number
  executed?: KnowledgeExecution
  failed?: boolean
}
export function recall(test: KnowledgeEvalCase, hits: KnowledgeHit[], key2: number): number {
  const refs = new Set(test.relevant.map((record) => record.ref))
  const found = new Set(
    hits
      .slice(0, key2)
      .map((hit) => hit.ref)
      .filter((ref) => refs.has(ref)),
  )
  return refs.size ? found.size / refs.size : 0
}
export function diagnose(
  test: KnowledgeEvalCase,
  hits: KnowledgeHit[],
  topK: number,
  indexed: Set<string>,
): KnowledgeMissDiagnosis {
  const refs = new Set(test.relevant.map((record2) => record2.ref))
  if (hits.slice(0, topK).some((hit2) => refs.has(hit2.ref))) return 'ok'
  if (hits.slice(0, 50).some((hit3) => refs.has(hit3.ref))) return 'low_rank'
  return [...refs].some((ref) => indexed.has(ref)) ? 'not_retrieved' : 'no_doc'
}
function ndcg(test: KnowledgeEvalCase, hits: KnowledgeHit[]): number {
  const grades = new Map(test.relevant.map((record3) => [record3.ref, record3.grade]))
  const seen = new Set<string>()
  const gain = (grade: number, rank: number) => (2 ** grade - 1) / Math.log2(rank + 2)
  const dcg = hits.slice(0, 10).reduce((sum, hit4, index) => {
    const grade = seen.has(hit4.ref) ? 0 : (grades.get(hit4.ref) ?? 0)
    seen.add(hit4.ref)
    return sum + gain(grade, index)
  }, 0)
  const ideal = [...grades.values()]
    .sort((left, right) => right - left)
    .slice(0, 10)
    .reduce((sum, grade, index2) => sum + gain(grade, index2), 0)
  return ideal ? dcg / ideal : 0
}
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      (expected.length
        ? expected.every((error) => actual.some((left2) => contains(left2, error)))
        : actual.length === 0)
    )
  if (expected && typeof expected === 'object')
    return (
      !!actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) =>
        contains((actual as Record<string, unknown>)[key], value),
      )
    )
  if (actual && typeof actual === 'object')
    return Object.values(actual).some((value) => contains(value, expected))
  return actual === expected
}
export function answerMatches(answer: string, hits: KnowledgeHit[]): boolean {
  const texts = hits.map((hit5) => hit5.content ?? hit5.snippet)
  try {
    const expected: unknown = JSON.parse(answer)
    const rows = texts.map((text) => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    })
    return rows.some((row) => contains(row, expected)) || contains(rows, expected)
  } catch {
    const values = answer
      .split(/[,，;；\n]+/)
      .map((value2) => value2.trim())
      .filter(Boolean)
    return values.length > 0 && values.every((value) => texts.some((text) => text.includes(value)))
  }
}
export function metrics(rows: Observation[], kind: string): KnowledgeEvalMetrics {
  const mean = (values: number[]) =>
    values.length ? values.reduce((left3, right2) => left3 + right2, 0) / values.length : 0
  const latencies = rows.map((record4) => record4.latencyMs).sort((left4, right3) => left4 - right3)
  const percentile = (paths: number) =>
    latencies.length ? latencies[Math.max(0, Math.ceil(paths * latencies.length) - 1)]! : 0
  const visible = (record5: Observation) => record5.hits.slice(0, record5.topK)
  const result: KnowledgeEvalMetrics = {
    n: rows.length,
    recall5: mean(rows.map((record6) => recall(record6.test, record6.hits, 5))),
    recall10: mean(rows.map((record7) => recall(record7.test, record7.hits, 10))),
    precision5: mean(
      rows.map(
        (record8) =>
          new Set(
            record8.hits
              .slice(0, 5)
              .filter((hit6) => record8.test.relevant.some((ref) => ref.ref === hit6.ref))
              .map((hit7) => hit7.ref),
          ).size / 5,
      ),
    ),
    mrr: mean(
      rows.map((record9) => {
        const index3 = record9.hits.findIndex((hit8) =>
          record9.test.relevant.some((ref) => ref.ref === hit8.ref),
        )
        return index3 < 0 ? 0 : 1 / (index3 + 1)
      }),
    ),
    ndcg10: mean(rows.map((record10) => ndcg(record10.test, record10.hits))),
    hitRate: mean(
      rows.map((record11) => Number(recall(record11.test, visible(record11), record11.topK) > 0)),
    ),
    emptyRate: mean(rows.map((record12) => Number(!visible(record12).length))),
    latencyP50: percentile(0.5),
    latencyP95: percentile(0.95),
    tokensPerQuery: mean(rows.map((record13) => record13.tokens)),
  }
  if (kind === 'database') {
    const sql = rows.filter((record14) => record14.executed?.kind === 'sql')
    const answers = sql.filter((record15) => record15.test.answer !== undefined)
    result.sqlSuccess = mean(
      sql.map((record16) => Number(!record16.failed && !record16.executed?.blocked)),
    )
    result.resultAccuracy = mean(
      answers.map((record17) =>
        Number(
          !record17.failed &&
            !record17.executed?.blocked &&
            answerMatches(record17.test.answer!, record17.hits),
        ),
      ),
    )
    result.blocked = sql.filter((record18) => record18.executed?.blocked).length
  }
  if (kind === 'api') {
    result.opAccuracy = mean(
      rows.map((record19) => Number(recall(record19.test, record19.hits, 1) > 0)),
    )
    const calls = rows.filter((record20) => record20.executed?.kind === 'http')
    result.callSuccess = mean(
      calls.map((record21) => Number(!record21.failed && !record21.executed?.blocked)),
    )
  }
  return result
}
export function wilson(wins: number, count: number): [number, number] {
  if (!count) return [0, 1]
  const value3 = 1.959963984540054
  const paths2 = wins / count
  const document = 1 + (value3 * value3) / count
  const center = (paths2 + (value3 * value3) / (2 * count)) / document
  const margin =
    (value3 *
      Math.sqrt((paths2 * (1 - paths2)) / count + (value3 * value3) / (4 * count * count))) /
    document
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}
export function compare(
  baseline: string,
  candidate: string,
  before: number[],
  after: number[],
): NonNullable<KnowledgeEvalRun['comparison']> {
  if (before.length !== after.length) throw new Error('评测用例不成对，请在同一评测集上重新运行')
  let wins = 0
  let losses = 0
  let ties = 0
  before.forEach((value, index4) => {
    const delta = after[index4]! - value
    if (delta > 1e-12) wins++
    else if (delta < -1e-12) losses++
    else ties++
  })
  const count2 = wins + losses
  const interval = wilson(wins, count2)
  return {
    baseline,
    candidate,
    wins,
    losses,
    ties,
    interval,
    recall10Delta: before.length
      ? after.reduce((sum, value, index5) => sum + value - before[index5]!, 0) / before.length
      : 0,
    verdict: !count2
      ? 'same'
      : count2 < 5
        ? 'inconclusive'
        : interval[0] > 0.5
          ? 'better'
          : interval[1] < 0.5
            ? 'worse'
            : 'inconclusive',
  }
}
