import type { QualityStatus, StewardDelegation } from '@taktflow/core'
import type { MockDb } from './mock-data'
import type { M5Source } from './source-m5'

/**
 * 质量日志状态（docs/design/21 §7）与管家转达重发（docs/design/26 §4）的演示数据。
 * 缺陷两层、合并建议、漏检改判与评测样本在 mock-eval.ts（与缺陷 / 用例共用状态）。
 */
type QualityApi = Pick<M5Source, 'qualityStatus' | 'syncQuality' | 'repairQuality' | 'resendDelegation'>

export function createMockQuality(db: MockDb): QualityApi {
  const clone = <T,>(v: T): T => structuredClone(v)
  const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
  const fail = (msg: string) => Promise.reject(new Error(msg))
  const seeded = db.requirements.length > 0
  const now = () => new Date().toISOString()
  const cursors = Object.fromEntries([...db.runs.values()].map((r) => [r.state.runId, Math.max(0, r.events.length - (r.state.status === 'running' ? 6 : 0))]))
  // 演示"链完整、锚点落后"：可以修复锚点；?mockQuality=broken 演示链被篡改（不给修复）
  const broken = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockQuality') === 'broken'
  const status: QualityStatus = !seeded
    ? { ok: true, entries: 0, cursors: {}, importedM3: false }
    : broken
      ? { ok: false, entries: 412, anchor: { seq: 412, hash: '5d2e91b0c7a34f6e5d2e91b0c7a34f6e5d2e91b0c7a34f6e5d2e91b0c7a34f6e' }, brokenAt: 287, cursors, lastSyncAt: new Date(Date.now() - 41 * 60_000).toISOString(), importedM3: true }
      : { ok: true, entries: 412, anchor: { seq: 398, hash: 'a1f0c3d9e27b4c18a1f0c3d9e27b4c18a1f0c3d9e27b4c18a1f0c3d9e27b4c18' }, anchorBehind: true, cursors, lastSyncAt: new Date(Date.now() - 3 * 60_000).toISOString(), importedM3: true }
  const needReason = (reason: string) => (reason.trim() ? undefined : fail('需要写原因'))

  return {
    qualityStatus: () => delay(status),
    syncQuality(body) {
      const bad = needReason(body.reason)
      if (bad) return bad
      if (!status.ok) return fail('哈希链被篡改或截断，暂停入账：先按说明人工核对')
      for (const r of db.runs.values()) if (!body.runId || body.runId === r.state.runId) status.cursors[r.state.runId] = r.events.length
      status.entries += 6
      status.lastSyncAt = now()
      return delay(status, 420)
    },
    repairQuality(reason) {
      const bad = needReason(reason)
      if (bad) return bad
      if (!status.ok) return fail('哈希链被篡改或截断，不能自动修复：先按说明人工核对')
      if (!status.anchorBehind) return fail('锚点已是最新，不需要修复')
      status.anchor = { seq: status.entries, hash: status.anchor?.hash ?? '0'.repeat(64) }
      status.anchorBehind = false
      status.entries += 1
      return delay(status, 360)
    },
    resendDelegation(messageId, reason) {
      const bad = needReason(reason)
      if (bad) return bad
      const d: StewardDelegation = { spaceId: 'hello-delivery', requirementId: 'REQ-002', messageId, status: 'sent', at: now() }
      return delay(d, 300)
    },
  }
}
