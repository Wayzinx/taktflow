import type { QualityLogEntry, QualityLogKind } from '../types.js'
import type { QualityInput } from './migration.js'
import { assertRequirementId } from '../store/paths.js'

const kinds: Record<QualityLogKind, true> = {
  'observation.recorded': true, 'defect.created': true, 'defect.updated': true, 'attribution.recorded': true,
  'attribution.confirmed': true, 'merge.suggested': true, 'merge.decided': true, 'sample.added': true,
  'sample.retired': true, 'eval.started': true, 'eval.finished': true, 'invocation.started': true, 'invocation.finished': true, recovery: true,
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function validateInput(entry: QualityInput): void {
  if (!Object.hasOwn(kinds, entry.kind) || !nonempty(entry.key) || !record(entry.data)) throw new Error('质量记录格式不合法；请提供 kind、幂等键和对象数据')
  const actor = entry.actor
  if (!record(actor) || !(actor.type === 'agent' ? nonempty(actor.role) && nonempty(actor.harness)
    : (actor.type === 'human' || actor.type === 'system') && nonempty(actor.id))) throw new Error('质量记录缺少合法操作者；请补充 actor')
  if (entry.requirementId !== undefined) assertRequirementId(entry.requirementId)
  const data = entry.data
  if (entry.kind !== 'observation.recorded' && !nonempty(data.reason)) throw new Error('质量写入必须填写 reason；请说明变更原因')
  if (entry.kind.startsWith('defect.') || entry.kind.startsWith('attribution.')) {
    const id = entry.kind.startsWith('defect.') ? data.id : data.defectId
    if (!entry.requirementId || typeof id !== 'string' || !/^D-[1-9]\d*$/.test(id)) throw new Error('缺陷记录缺少合法的需求 / 缺陷 id；请核对身份')
    if (data.requirementId !== undefined && data.requirementId !== entry.requirementId) throw new Error('缺陷需求身份不一致；请核对 requirementId')
  }
  if (entry.kind === 'defect.created' && (!nonempty(data.title) || !nonempty(data.description) || !nonempty(data.foundAt)
    || !['critical', 'major', 'minor'].includes(data.severity as string) || !['open', 'attributed', 'confirmed', 'closed'].includes(data.status as string))) {
    throw new Error('新缺陷缺少必要字段；请提供标题、描述、严重性、状态和发现时间')
  }
  if (entry.kind === 'observation.recorded') {
    if (!nonempty(data.id) || !nonempty(data.title) || data.requirementId !== entry.requirementId
      || !['review', 'judge', 'gate', 'human', 'external'].includes(data.source as string)
      || !['finding', 'claimed_fixed', 'verified_fixed', 'declined', 'waived', 'failure', 'ignored', 'flaky', 'gate_fail', 'gate_error', 'report'].includes(data.kind as string)) {
      throw new Error('观察记录缺少合法身份或分类；请核对源事件')
    }
  }
  if (entry.kind.startsWith('sample.') || entry.kind.startsWith('eval.') || entry.kind.startsWith('merge.')) {
    if (!nonempty(data.id)) throw new Error('质量记录缺少对象 id；请补充 id')
  }
  if (entry.kind.startsWith('invocation.')) {
    if (!nonempty(data.id) || actor.type !== 'agent' || actor.invocationId !== data.id) throw new Error('调用审计身份不合法；请提供一致的 id 与 actor.invocationId')
    const resolved = (value: unknown) => record(value) && ['requested', 'resolved', 'reported'].every(key => value[key] === undefined || typeof value[key] === 'string')
      && (value.applied === undefined || typeof value.applied === 'boolean')
    if (entry.kind === 'invocation.started' && (!nonempty(data.nodeId) || !Number.isSafeInteger(data.attempt) || Number(data.attempt) < 1
      || !Number.isSafeInteger(data.fallbackIndex) || Number(data.fallbackIndex) < 0 || !nonempty(data.harness)
      || !['producer', 'author', 'reviewer', 'arbiter', 'rubric', 'acceptance', 'command', 'judge', 'planner', 'auditor', 'evaluator'].includes(data.role as string)
      || !nonempty(data.at) || !Number.isFinite(Date.parse(data.at)) || !resolved(data.model) || !resolved(data.effort)
      || !Array.isArray(data.skills) || data.skills.some(skill => !record(skill) || !nonempty(skill.name)
        || !['yes', 'no', 'unknown'].includes(skill.confirmed as string) || skill.providedHash !== undefined && !nonempty(skill.providedHash)))) {
      throw new Error('调用开始数据不合法；请补齐 attempt、fallbackIndex、角色、三层取值与技能')
    }
    if (entry.kind === 'invocation.finished' && (!['ok', 'error', 'cancelled'].includes(data.outcome as string)
      || typeof data.durationMs !== 'number' || !Number.isFinite(data.durationMs) || data.durationMs < 0
      || data.reported !== undefined && (!record(data.reported)
        || ['model', 'effort'].some(key => data.reported && record(data.reported) && data.reported[key] !== undefined && typeof data.reported[key] !== 'string')
        || data.reported.skills !== undefined && (!Array.isArray(data.reported.skills) || data.reported.skills.some(skill => typeof skill !== 'string'))))) {
      throw new Error('调用结束数据不合法；请提供结果、耗时与合法的 harness 回报')
    }
  }
  if (entry.kind === 'attribution.confirmed' && (actor.type !== 'human' || !record(data.confirmed) || !record(data.confirmed.by) || data.confirmed.by.type !== 'human')) {
    throw new Error('归因确认必须由人作出；请提交人工确认记录')
  }
  if (entry.kind.startsWith('attribution.') && actor.type !== 'human' && (data.confirmed !== undefined
    || Array.isArray(data.checkpoints) && data.checkpoints.some((item: unknown) => record(item) && (item.by === 'human' || item.confirmed !== undefined)))) {
    throw new Error('自动归因不能携带人工确认或改判；请只提交候选结论')
  }
  if (entry.kind === 'merge.decided' && actor.type !== 'human') throw new Error('合并决定必须由人作出；请提交人工决定')
}

export function isQualityEntry(value: unknown): value is QualityLogEntry {
  if (!record(value) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
    || !nonempty(value.ts) || !Number.isFinite(Date.parse(value.ts))
    || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
    || typeof value.prevHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.prevHash)) return false
  try { validateInput(value as unknown as QualityInput); return true } catch { return false }
}
