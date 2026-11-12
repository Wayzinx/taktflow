import { describe, expect, it } from 'vitest'
import type { QualityStatus } from '@taktflow/core'
import { qualityAlertOf } from './overview-quality-alert'

const base: QualityStatus = { ok: true, entries: 12, cursors: {} }

describe('qualityAlertOf', () => {
  it('健康或状态未读到时不给告警', () => {
    expect(qualityAlertOf(undefined)).toBeUndefined()
    expect(qualityAlertOf(base)).toBeUndefined()
    expect(qualityAlertOf({ ...base, anchor: { seq: 12, hash: 'h' } })).toBeUndefined()
  })

  it('断链时给失败告警并带上断点，指向质量日志页', () => {
    const alert = qualityAlertOf({ ...base, ok: false, entries: 30, brokenAt: 17 })
    expect(alert?.tone).toBe('failed')
    expect(alert?.hint).toContain('第 17 条')
    expect(alert?.to).toBe('/settings?tab=quality')
  })

  it('锚点落后时给等待告警，同样指向质量日志页', () => {
    const alert = qualityAlertOf({ ...base, anchorBehind: true, anchor: { seq: 10, hash: 'h' } })
    expect(alert?.tone).toBe('waiting')
    expect(alert?.hint).toContain('锚点')
    expect(alert?.to).toBe('/settings?tab=quality')
  })
})
