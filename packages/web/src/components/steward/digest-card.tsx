import type { ReactNode } from 'react'
import { ArrowRight, CircleCheck, CirclePlus, CircleX, Inbox, OctagonPause, Play, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react'
import type { Digest, Risk, StewardContextRef } from '@taktflow/core'
import { useSource } from '../../api'
import { fmtRelative } from '../../lib/format'
import { hm, since } from './fmt'
import { jumpTo } from './jump'
import { RiskCard } from './risk-card'
import './cards.css'

const PROGRESS: Record<Digest['progress'][number]['kind'], { icon: LucideIcon; label: string; tone: string }> = {
  created: { icon: CirclePlus, label: '新建', tone: 'pending' },
  started: { icon: Play, label: '启动', tone: 'running' },
  stage: { icon: ArrowRight, label: '推进', tone: 'running' },
  delivered: { icon: CircleCheck, label: '已交付', tone: 'success' },
  failed: { icon: CircleX, label: '失败', tone: 'failed' },
  blocked: { icon: OctagonPause, label: '卡住', tone: 'waiting' },
}

function Section({ title, count, children, empty }: { title: string; count: number; children: ReactNode; empty: string }) {
  return (
    <section className="stw-digest-sec">
      <h4 className="stw-digest-h">
        {title}
        <span className="stw-count num">{count}</span>
      </h4>
      {count ? children : <p className="faint stw-digest-none">{empty}</p>}
    </section>
  )
}

/**
 * 汇报卡（docs/design/22 §1.6）：顶部两句摘要（模型写），下面四段由规则生成：需要你处理 → 新风险 → 进展 → 指标变化。
 * 点任何一条：跳转并高亮，同时上报 digest.click。
 */
export function DigestCard({ digest, onRisk, onAsk, className }: { digest: Digest; onRisk?: (r: Risk) => void; onAsk?: (text: string, ctx: StewardContextRef[]) => void; className?: string }) {
  const ds = useSource()
  const go = (href: string, label?: string) => {
    void ds.reportProductEvent({ type: 'digest.click', feature: 'steward.digest', detail: { href } }).catch(() => undefined)
    jumpTo(href, label)
  }
  return (
    <section className={`stw-digest${className ? ` ${className}` : ''}`} aria-label="管家汇报" data-steward-anchor="digest">
      <header className="stw-digest-head">
        <span className="section-label">汇报 · {hm(digest.at)}</span>
        {digest.since && <span className="faint">自 {fmtRelative(digest.since)}以来</span>}
      </header>
      <p className="stw-digest-summary">{digest.summary}</p>
      <div className="stw-digest-grid">
        <Section title="需要你处理" count={digest.attention.length} empty="没有等你的事">
          <ul className="stw-digest-list">
            {digest.attention.map((a) => (
              <li key={a.requestId}>
                <a href={a.href} className="stw-digest-row pressable" onClick={(e) => (e.preventDefault(), go(a.href, a.requirementId))}>
                  <Inbox className="stw-digest-icon" data-tone="waiting" aria-hidden />
                  <span className="stw-digest-main">
                    <span className="stw-digest-title">{a.ask}</span>
                    <span className="faint truncate">
                      <span className="mono">{a.requirementId}</span> {a.requirementTitle}
                    </span>
                  </span>
                  <span className="faint num">等了 {since(a.since)}</span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="新风险" count={digest.risks.length} empty="没有新风险">
          <div className="stw-digest-risks">
            {digest.risks.map((r) => (
              <RiskCard key={r.key} risk={r} compact onChange={onRisk} onAsk={onAsk} />
            ))}
          </div>
        </Section>
        <Section title="进展" count={digest.progress.length} empty="这段时间没有推进">
          <ul className="stw-digest-list">
            {digest.progress.map((p) => {
              const k = PROGRESS[p.kind]
              const Icon = k.icon
              return (
                <li key={`${p.requirementId}-${p.kind}-${p.at}`}>
                  <a href={p.href} className="stw-digest-row pressable" onClick={(e) => (e.preventDefault(), go(p.href, p.requirementId))}>
                    <Icon className="stw-digest-icon" data-tone={k.tone} aria-hidden />
                    <span className="stw-digest-main">
                      <span className="stw-digest-title">
                        <span className="mono">{p.requirementId}</span> {p.title}
                      </span>
                      <span className="faint">{p.kind === 'stage' && p.from ? `${p.from} → ${p.to}` : k.label}</span>
                    </span>
                    <span className="faint num">{fmtRelative(p.at)}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        </Section>
        <Section title="指标变化" count={digest.metrics?.length ?? 0} empty="指标没有明显变化">
          <div className="stw-digest-metrics">
            {(digest.metrics ?? []).map((m) => {
              const up = m.delta?.startsWith('+')
              const Trend = up ? TrendingUp : TrendingDown
              return (
                <div key={m.label} className="stw-metric">
                  <span className="stw-metric-label">{m.label}</span>
                  <span className="stw-metric-value num">{m.value}</span>
                  {m.delta && (
                    <span className="stw-metric-delta num faint">
                      <Trend aria-hidden />
                      {m.delta}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </Section>
      </div>
    </section>
  )
}
