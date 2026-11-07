import { useEffect, useState } from 'react'
import { CornerDownRight, ShieldCheck } from 'lucide-react'
import type { Risk, StewardContextRef } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { DigestCard } from '../../components/steward/digest-card'
import { markDigestSeen, peekDigest } from '../../components/steward/digest-session'
import { RiskCard } from '../../components/steward/risk-card'
import { EmptyState, ErrorState, Skeleton, SkeletonCard, SkeletonText, useStagger } from '../../components/ui'

function HomeSkeleton() {
  return (
    <div className="stwp-home" role="status" aria-label="正在读取汇报">
      <div className="stw-digest">
        <Skeleton w={120} h={11} />
        <SkeletonText lines={2} width="70%" />
        <div className="stw-digest-grid">
          <SkeletonCard height={150} />
          <SkeletonCard height={150} />
        </div>
      </div>
    </div>
  )
}

/**
 * 管家页没选会话时的右栏："今天"——最新汇报 + 风险清单 + 可以直接问的问题；打开即标已读（digest-session.ts）。
 * ask：直接用这句话开一个新会话。
 */
export function StewardHome({ ask, suggestions }: { ask: (text: string, ctx?: StewardContextRef[]) => void; suggestions: string[] }) {
  const ds = useSource()
  const digest = useAsync((d) => peekDigest(d), [])
  const risks = useAsync((d) => d.risks(), [])
  const [local, setLocal] = useState<Record<string, Risk>>({})
  const [showQuiet, setShowQuiet] = useState(false)
  // 打开管家页就算看过汇报：标已读一次（服务端记 digest.open、清未读）
  const digestId = digest.data?.id
  useEffect(() => {
    if (digestId) markDigestSeen(ds, digestId)
  }, [ds, digestId])
  const all = (risks.data ?? []).map((r) => local[r.key] ?? r)
  const open = all.filter((r) => r.state === 'open').sort((a, b) => (a.level === b.level ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.level === 'high' ? -1 : 1))
  const quiet = all.filter((r) => r.state === 'snoozed' || r.state === 'ignored')
  const st = useStagger(risks.data ? open.length : 0)
  const onRisk = (r: Risk) => setLocal((cur) => ({ ...cur, [r.key]: r }))
  const onAsk = (text: string, ctx: StewardContextRef[]) => ask(text, ctx)

  if (digest.error && !digest.data) return <ErrorState error={digest.error} onRetry={digest.reload} />
  if (!digest.data) return <HomeSkeleton />
  const d = { ...digest.data, risks: digest.data.risks.map((r) => local[r.key] ?? r).filter((r) => r.state === 'open') }
  return (
    <div className="stwp-home">
      <DigestCard digest={d} onRisk={onRisk} onAsk={onAsk} />

      <section className="stwp-sec" aria-label="风险">
        <h3 className="stwp-sec-h">
          全部风险
          <span className="stw-count num">{open.length}</span>
          {quiet.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm stwp-sec-more" aria-expanded={showQuiet} onClick={() => setShowQuiet((v) => !v)}>
              {showQuiet ? '收起' : `已推迟 / 已忽略 ${quiet.length} 条`}
            </button>
          )}
        </h3>
        {risks.error && !risks.data ? (
          <ErrorState compact error={risks.error} onRetry={risks.reload} />
        ) : !risks.data ? (
          <SkeletonCard height={120} />
        ) : open.length === 0 ? (
          <EmptyState compact icon={ShieldCheck} title="没有未处理的风险" body="风险由规则产生：等人太久、预算、停滞、重复失败等" />
        ) : (
          <div className="stwp-risks">
            {open.map((r, i) => (
              <RiskCard key={r.key} risk={r} onChange={onRisk} onAsk={onAsk} {...st(i)} />
            ))}
          </div>
        )}
        <div className="expand" data-open={showQuiet}>
          <div>
            <div className="stwp-risks stwp-risks-quiet">
              {quiet.map((r) => (
                <RiskCard key={r.key} risk={r} onChange={onRisk} onAsk={onAsk} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {suggestions.length > 0 && (
        <section className="stwp-sec" aria-label="可以问">
          <h3 className="stwp-sec-h">可以直接问</h3>
          <div className="stw-welcome-list">
            {suggestions.map((s) => (
              <button key={s} type="button" className="stw-welcome-item pressable" onClick={() => ask(s)}>
                <CornerDownRight aria-hidden />
                <span>{s}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
