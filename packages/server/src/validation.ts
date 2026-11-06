import { assertArtifactPath, assertNodeId, assertRequirementId, assertRunId } from '@taktflow/core'
import { ApiError } from './errors.js'

function validated(value: unknown, validate: (value: string) => string): string {
  if (typeof value !== 'string') throw new ApiError(400, '必须提供字符串路径或 ID')
  try { return validate(value) } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : String(error))
  }
}

export const safeId = (value: string): string => validated(value, assertRequirementId)
export const runId = (value: string): string => validated(value, assertRunId)
export const relativePath = (value: unknown): string => validated(value, assertNodeId)

export const artifactPath = (value: unknown): string => validated(value, assertArtifactPath)

export function integer(value: string | null | undefined, name: string, min = 0): number | undefined {
  if (value === null || value === undefined) return undefined
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new ApiError(400, `${name} 不合法`)
  return Number(value)
}

export function text(value: unknown, name: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new ApiError(400, `${name} 必须是${empty ? '' : '非空'}字符串`)
  return value
}
