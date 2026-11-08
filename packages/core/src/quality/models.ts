import type { Defect, DefectAttribution, DefectMergeSuggestion, EvalCase, EvalRun, Observation, QualityLogEntry } from '../types.js'

export type QualityDefect = Defect & { attribution?: DefectAttribution }
export interface QualityViews {
  observations: Observation[]
  defects: QualityDefect[]
  attributions: Array<{ requirementId: string; attribution: DefectAttribution }>
  merges: Array<DefectMergeSuggestion & { requirementId?: string }>
  samples: EvalCase[]
  evaluations: EvalRun[]
}

export function defectKey(requirementId: string, id: string): string { return `${requirementId}:${id}` }

function mergeAttribution(old: DefectAttribution | undefined, next: DefectAttribution, human: boolean): DefectAttribution {
  if (old?.confirmed && !human) return old
  const checkpoints = new Map(old?.checkpoints?.map((item) => [item.checkpointId, item]))
  for (const item of next.checkpoints ?? []) {
    const previous = checkpoints.get(item.checkpointId)
    if (!human && (previous?.by === 'human' || previous?.confirmed)) continue
    checkpoints.set(item.checkpointId, item)
  }
  return { ...old, ...next, ...(checkpoints.size ? { checkpoints: [...checkpoints.values()] } : {}) }
}

// data 使用协议对象本身；更新可只带 id 与变更字段，reason 仅保留在日志中。
export function buildViews(entries: QualityLogEntry[]): QualityViews {
  const observations = new Map<string, Observation>()
  const defects = new Map<string, QualityDefect>()
  const attributions = new Map<string, { requirementId: string; attribution: DefectAttribution }>()
  const protectedFields = new Map<string, Set<string>>()
  const merges = new Map<string, DefectMergeSuggestion & { requirementId?: string }>()
  const samples = new Map<string, EvalCase>()
  const evaluations = new Map<string, EvalRun>()
  for (const entry of entries) {
    const { reason: _reason, baseRevision: _baseRevision, ...data } = structuredClone(entry.data) as Record<string, unknown>
    const human = entry.actor.type === 'human'
    if (entry.kind === 'observation.recorded') {
      const observation = data as unknown as Observation
      if (!observations.has(observation.id)) observations.set(observation.id, observation)
    } else if (entry.kind === 'defect.created' || entry.kind === 'defect.updated') {
      const patch = data as unknown as Defect
      const requirementId = entry.requirementId ?? patch.requirementId
      const key = defectKey(requirementId, patch.id), old = defects.get(key)
      const protectedKeys = protectedFields.get(key) ?? new Set<string>()
      const fields = ['status', 'validity', 'resolution', 'duplicateOf', 'observations']
      if (entry.kind === 'defect.created' && (patch.status === 'confirmed' || patch.status === 'closed')) protectedKeys.add('status')
      if (entry.kind === 'defect.updated' || patch.status === 'confirmed' || patch.status === 'closed') {
        for (const field of fields) {
          if (human && field in data) protectedKeys.add(field)
          else if (!human && old && protectedKeys.has(field)) delete data[field]
        }
      }
      protectedFields.set(key, protectedKeys)
      const next = { ...old, ...data, id: patch.id, requirementId, revision: (old?.revision ?? 0) + 1 } as QualityDefect
      // M3 的 closed 不证明经过逐键复查，因此不推断 verified_fixed。
      next.validity ??= next.status === 'confirmed' ? 'valid' : 'unconfirmed'
      next.resolution ??= 'open'
      defects.set(key, next)
    } else if (entry.kind === 'attribution.recorded' || entry.kind === 'attribution.confirmed') {
      const next = data as unknown as DefectAttribution
      const key = defectKey(entry.requirementId!, next.defectId)
      attributions.set(key, { requirementId: entry.requirementId!, attribution: mergeAttribution(attributions.get(key)?.attribution, next, human) })
      if (human && entry.kind === 'attribution.confirmed') {
        const fields = protectedFields.get(key) ?? new Set<string>()
        fields.add('status')
        protectedFields.set(key, fields)
      }
    } else if (entry.kind === 'merge.suggested' || entry.kind === 'merge.decided') {
      const next = { ...data, reason: _reason } as unknown as DefectMergeSuggestion
      const key = defectKey(entry.requirementId ?? '', next.id), old = merges.get(key)
      if (!human && old && old.status !== 'suggested') continue
      merges.set(key, { ...old, ...next, requirementId: entry.requirementId })
    } else if (entry.kind === 'sample.added') {
      const next = data as unknown as EvalCase
      samples.set(next.id, next)
    } else if (entry.kind === 'sample.retired') {
      const sample = samples.get(data.id as string)
      if (sample?.sample) sample.sample = { ...sample.sample, retiredAt: (data.retiredAt as string | undefined) ?? entry.ts }
    } else if (entry.kind === 'eval.started' || entry.kind === 'eval.finished') {
      const next = data as unknown as EvalRun
      evaluations.set(next.id, { ...evaluations.get(next.id), ...next })
    }
  }
  for (const [key, defect] of defects) {
    const attribution = attributions.get(key)?.attribution
    if (attribution) defect.attribution = attribution
  }
  for (const observation of observations.values()) {
    observation.defects = [...defects.values()].filter((d) => d.requirementId === observation.requirementId && d.observations?.includes(observation.id)).map((d) => d.id)
  }
  return { observations: [...observations.values()], defects: [...defects.values()], attributions: [...attributions.values()],
    merges: [...merges.values()], samples: [...samples.values()], evaluations: [...evaluations.values()] }
}
