import type { ReviewDisposition } from '@taktflow/core'

/** 处置是否仍然有效：处置时的指纹与当前问题指纹一致才算（指纹变了处置自动失效）。 */
export function effectiveDisposition(list: ReviewDisposition[] | undefined, groupKey: string | undefined, fingerprint: string | undefined) {
  if (!groupKey || !list?.length) return { current: undefined, expired: undefined }
  const d = [...list].reverse().find((x) => x.groupKey === groupKey)
  if (!d) return { current: undefined, expired: undefined }
  if (d.fingerprint && fingerprint && d.fingerprint !== fingerprint) return { current: undefined, expired: d }
  return { current: d, expired: undefined }
}
