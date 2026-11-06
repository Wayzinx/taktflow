import type { Candidate, DefectView, EvalCaseView, EvalReportView, Observation } from '../quality.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { QualityRevisionConflict, type QualityCursor, type QualityCursorKey, type QualityEventEnvelope } from './quality-store.js'

export interface QualityViews {
  defects: Map<string, DefectView>
  observations: Map<string, Observation>
  evalcases: Map<string, EvalCaseView>
  candidates: Map<string, Candidate>
  evals: Map<string, EvalReportView>
  cursors: Map<string, QualityCursor>
  revisions: Map<string, number>
  samples: Set<string>
}

export const cursorKey = (key: QualityCursorKey): string => JSON.stringify([key.runId, key.processor, key.processorVersion])

export function checkRevision(views: QualityViews, key: string, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error(`非法 baseRevision：${key}`)
  const actual = views.revisions.get(key) ?? 0
  if (actual !== expected) throw new QualityRevisionConflict(key, expected, actual)
}

function required<T>(items: Map<string, T>, id: string, kind: string): T {
  const item = items.get(id)
  if (!item) throw new Error(`${kind}不存在：${id}`)
  return item
}

function fresh(items: Map<string, unknown>, id: string): void {
  if (!id || items.has(id)) throw new Error(`质量实体已存在或 ID 为空：${id}`)
}

function bump(views: QualityViews, key: string): number {
  const revision = (views.revisions.get(key) ?? 0) + 1
  views.revisions.set(key, revision)
  return revision
}

export function reduceQuality(events: QualityEventEnvelope[]): QualityViews {
  const views: QualityViews = {
    defects: new Map(), observations: new Map(), evalcases: new Map(), candidates: new Map(),
    evals: new Map(), cursors: new Map(), revisions: new Map(), samples: new Set(),
  }
  for (const event of events) applyQualityEvent(views, event)
  return views
}

export function applyQualityEvent(views: QualityViews, event: QualityEventEnvelope): void {
  switch (event.type) {
    case 'observation.recorded': {
      fresh(views.observations, event.data.id)
      views.observations.set(event.data.id, structuredClone(event.data))
      break
    }
    case 'defect.created': {
      const defect = structuredClone(event.data.defect)
      fresh(views.defects, defect.id)
      views.defects.set(defect.id, { ...defect, revision: bump(views, `defect:${defect.id}`), updatedAt: event.ts })
      break
    }
    case 'defect.updated': {
      const { id, baseRevision, patch } = event.data
      const defect = required(views.defects, id, '缺陷')
      checkRevision(views, `defect:${id}`, baseRevision)
      // 按冻结字段取值，磁盘或 API 输入不能借 patch 改写创建者、归因和 revision。
      for (const key of ['title', 'severity', 'validity', 'resolution', 'duplicateOf'] as const) {
        if (patch[key] !== undefined) Object.assign(defect, { [key]: patch[key] })
      }
      defect.observations = [...new Set([...defect.observations, ...patch.addObservations ?? []])]
        .filter((id) => !patch.removeObservations?.includes(id))
      defect.revision = bump(views, `defect:${id}`)
      defect.updatedAt = event.ts
      break
    }
    case 'attribution.recorded': {
      const { defectId, baseRevision, attribution } = event.data
      const defect = required(views.defects, defectId, '缺陷')
      checkRevision(views, `defect:${defectId}`, baseRevision)
      if (attribution.method !== 'human' && (attribution.status === 'confirmed'
        || (defect.attribution?.method === 'human' && ['confirmed', 'disputed'].includes(defect.attribution.status)))) {
        throw new Error(`自动归因不能确认或覆盖人工结论：${defectId}`)
      }
      defect.attribution = structuredClone(attribution)
      defect.revision = bump(views, `defect:${defectId}`)
      defect.updatedAt = event.ts
      break
    }
    case 'evalcase.added': {
      const item = event.data.case
      fresh(views.evalcases, item.id)
      if (item.revision !== 1) throw new Error(`新增评测样本 revision 必须为 1：${item.id}`)
      views.evalcases.set(item.id, structuredClone(item))
      bump(views, `evalcase:${item.id}`)
      break
    }
    case 'evalcase.updated': {
      const { id, baseRevision, status } = event.data
      const item = required(views.evalcases, id, '评测样本')
      checkRevision(views, `evalcase:${id}`, baseRevision)
      item.status = status
      item.revision = bump(views, `evalcase:${id}`)
      break
    }
    case 'candidate.created': {
      const candidate = event.data.candidate
      fresh(views.candidates, candidate.candidateId)
      views.candidates.set(candidate.candidateId, structuredClone(candidate))
      break
    }
    case 'eval.started': {
      const data = event.data
      fresh(views.evals, data.evalId)
      required(views.candidates, data.candidateId, '候选包')
      if (data.baseline !== 'origin') required(views.candidates, data.baseline, '基线候选包')
      if (!Number.isSafeInteger(data.samples) || data.samples < 1) throw new Error('评测重复次数必须为正整数')
      if (new Set(data.caseIds).size !== data.caseIds.length) throw new Error('评测样本 ID 重复')
      const cases = data.caseIds.map((id) => required(views.evalcases, id, '评测样本'))
      views.evals.set(data.evalId, {
        evalId: data.evalId, candidateId: data.candidateId, baseline: data.baseline,
        evalSetRevision: sha256(canonicalJson(cases)), judgeRecipeId: data.judgeRecipeId, samples: data.samples,
        cases: cases.map((item) => ({ caseId: item.id, baseline: Array(data.samples).fill('insufficient'),
          candidate: Array(data.samples).fill('insufficient'), falsePositives: { baseline: 0, candidate: 0 }, notes: [] })),
        kind: 'exploratory', status: 'running', startedAt: event.ts,
      })
      bump(views, `eval:${data.evalId}`)
      break
    }
    case 'eval.sample': {
      const data = event.data
      const report = required(views.evals, data.evalId, '评测')
      if (report.status !== 'running') throw new Error(`评测已结束：${data.evalId}`)
      const item = report.cases.find((item) => item.caseId === data.caseId)
      if (!item || !Number.isSafeInteger(data.index) || data.index < 0 || data.index >= report.samples) throw new Error('评测样本或重复序号不合法')
      const key = JSON.stringify([data.evalId, data.caseId, data.arm, data.index])
      if (views.samples.has(key)) throw new Error(`评测样本结果已存在：${key}`)
      views.samples.add(key)
      item[data.arm][data.index] = data.outcome
      if (data.falsePositive) item.falsePositives[data.arm] += 1
      if (data.note) item.notes.push(data.note)
      bump(views, `eval:${data.evalId}`)
      break
    }
    case 'eval.finished': {
      const report = required(views.evals, event.data.evalId, '评测')
      if (report.status !== 'running') throw new Error(`评测已结束：${report.evalId}`)
      if (report.cases.length === 0 && event.data.status === 'done') throw new Error('零适用样本不能完成评测')
      report.status = event.data.status
      report.finishedAt = event.ts
      if (event.data.error) for (const item of report.cases) item.notes.push(event.data.error)
      bump(views, `eval:${report.evalId}`)
      break
    }
    case 'cursor.advanced': {
      const cursor = event.data
      if (!Number.isSafeInteger(cursor.seq) || cursor.seq < 0 || !cursor.runId || !cursor.processor || !cursor.processorVersion) throw new Error('质量游标不合法')
      const key = cursorKey(cursor)
      if ((views.cursors.get(key)?.seq ?? 0) < cursor.seq) views.cursors.set(key, structuredClone(cursor))
      break
    }
    case 'log.recovered': break
  }
}
