import { useId, useState, type CSSProperties } from 'react'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import type { QualityMetrics, RunDetail } from '@taktflow/core'
import { usePresence } from '../../lib/motion'
import './run-counters.css'

const SOURCES: Array<{ key: keyof QualityMetrics['interceptedBy']; label: string; hint: string }> = [
  { key: 'gate', label: '门禁', hint: '未通过的门禁检查' },
  { key: 'review', label: '评审', hint: '未通过评审轮里的 blocker / major' },
  { key: 'judge', label: '判决', hint: '判为 product_bug 的失败' },
  { key: 'completion', label: '完成标准', hint: '自检未满足或缺证据' },
  { key: 'fingerprint', label: '失败指纹', hint: '被抑制的重复重试' },
]

/**
 * 运行页顶部计数："已校验 / 已拦截"（拦截按来源，悬停或聚焦展开）与 LIVE 标记。
 * LIVE 只在运行真的活着时出现：running 跟着节拍跳，waiting_human 静止（在等人，不在跑）。
 */
export function RunCounters({ detail }: { detail: RunDetail }) {
  const q = detail.quality
  const status = detail.run.status
  const live = status === 'running' || status === 'waiting_human'
  if (!q && !live) return null
  return (
    <span className="run-counters">
      {live && (
        <span className={`run-live${status === 'running' ? ' beating' : ''}`} title={status === 'running' ? '运行中，事件实时推送' : '等人处理，事件实时推送'}>
          <i aria-hidden />
          LIVE
        </span>
      )}
      {q && (
        <>
          <span className="run-count tone-ok" title="通过的门禁检查（含交付校验）与通过的评审轮">
            <ShieldCheck aria-hidden />
            已校验
            <b className="mono num">{q.verified}</b>
          </span>
          <Intercepted q={q} />
        </>
      )}
    </span>
  )
}

function Intercepted({ q }: { q: QualityMetrics }) {
  const [open, setOpen] = useState(false)
  const p = usePresence(open, 120)
  const id = useId()
  const max = Math.max(1, ...SOURCES.map((s) => q.interceptedBy[s.key]))
  return (
    <span className="run-count-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={`run-count tone-cut${q.intercepted > 0 ? ' has' : ''}`}
        aria-describedby={p.mounted ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        <ShieldAlert aria-hidden />
        已拦截
        <b className="mono num">{q.intercepted}</b>
      </button>
      {p.mounted && (
        <span className="run-count-pop" role="tooltip" id={id} data-state={p.state}>
          <span className="run-count-pop-head">交付前拦下的问题，按来源</span>
          {SOURCES.map((s) => {
            const n = q.interceptedBy[s.key]
            return (
              <span key={s.key} className={`run-count-row${n ? '' : ' zero'}`} title={s.hint}>
                <span className="run-count-label">{s.label}</span>
                <span className="meter" data-tone={n ? 'warning' : undefined} style={{ '--meter': n / max } as CSSProperties}>
                  <span className="meter-fill" />
                </span>
                <b className="mono num">{n}</b>
              </span>
            )
          })}
        </span>
      )}
    </span>
  )
}
