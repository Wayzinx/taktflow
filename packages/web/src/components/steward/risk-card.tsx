import { useRef, useState, type CSSProperties } from 'react'
import { ArrowUpRight, BellOff, BellRing, Clock, EyeOff, OctagonAlert, Sparkles, TriangleAlert } from 'lucide-react'
import type { Risk, RiskAction, StewardContextRef } from '@taktflow/core'
import { useSource } from '../../api'
import { Menu, toast } from '../ui'
import { fmtRelative } from '../../lib/format'
import { hm } from './fmt'
import { askSteward } from '../../lib/ui-store'
import { jumpTo } from './jump'
import './cards.css'

export const RISK_LEVEL = {
  high: { label: '高', icon: OctagonAlert, tone: 'failed' },
  medium: { label: '中', icon: TriangleAlert, tone: 'waiting' },
} as const

const KIND_LABEL: Record<Risk['kind'], string> = {
  'waiting-human': '等人处理',
  budget: '预算',
  stalled: '停滞',
  'repeat-failure': '重复失败',
  'review-stuck': '评审卡住',
  'gate-failed': '校验未过',
  deadline: '截止时间',
  'defect-escape': '缺陷逃逸',
  regression: '退化',
  knowledge: '知识库',
}

const SNOOZE = [
  { id: '1h', label: '1 小时后', ms: 3600_000 },
  { id: '3h', label: '3 小时后', ms: 3 * 3600_000 },
  { id: 'tomorrow', label: '明天 09:30', ms: 0 },
]
const tomorrow930 = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 30, 0, 0)
  return d.toISOString()
}

export function riskContext(r: Risk): StewardContextRef[] {
  const out: StewardContextRef[] = [{ type: 'space', id: r.spaceId, label: r.spaceId }]
  if (r.requirementId) out.push({ type: 'requirement', spaceId: r.spaceId, id: r.requirementId, label: r.requirementId })
  if (r.runId) out.push({ type: 'run', spaceId: r.spaceId, id: r.runId, label: r.runId })
  return out
}

/**
 * 风险卡（docs/design/22 §1.6）：级别、标题、说明、证据链接、建议动作（跳转 / 交给管家 / 生成命令提案）、稍后提醒 / 忽略。
 * onAsk：在整页里直接发给当前会话；不传则打开停靠面板预填。
 */
export function RiskCard({ risk, onChange, onAsk, compact, className, style }: { risk: Risk; onChange?: (r: Risk) => void; onAsk?: (text: string, ctx: StewardContextRef[]) => void; compact?: boolean; className?: string; style?: CSSProperties }) {
  const ds = useSource()
  const snoozeBtn = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const lv = RISK_LEVEL[risk.level]
  const Icon = lv.icon
  const ask = onAsk ?? ((t: string, c: StewardContextRef[]) => askSteward(t, c))

  const setState = async (state: 'open' | 'snoozed' | 'ignored', until?: string) => {
    const prev = risk
    setBusy(true)
    try {
      const next = await ds.setRiskState(risk.key, { state, until })
      onChange?.(next)
      void ds.reportProductEvent({ type: 'risk.action', feature: 'steward.digest', spaceId: risk.spaceId, detail: { action: state } }).catch(() => undefined)
      if (state !== 'open')
        toast(state === 'ignored' ? '已忽略这条风险' : `会在 ${hm(next.snoozedUntil ?? until ?? '')} 再提醒`, {
          body: risk.title,
          undo: async () => onChange?.(await ds.setRiskState(prev.key, { state: 'open' })),
        })
    } catch (e) {
      toast('操作失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const act = (a: RiskAction) => {
    void ds.reportProductEvent({ type: 'risk.action', feature: 'steward.digest', spaceId: risk.spaceId, detail: { action: a.label } }).catch(() => undefined)
    if (a.href) return jumpTo(a.href, risk.requirementId)
    if (a.ask) return ask(a.ask, riskContext(risk))
    if (a.commandId) return ask(`${a.label}（${risk.title}）：请生成提案，命令 ${a.commandId}，参数 ${JSON.stringify(a.input ?? {})}`, riskContext(risk))
  }

  return (
    <article className={`stw-risk${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`} data-level={risk.level} data-state={risk.state} data-steward-anchor={risk.key} style={style}>
      <div className="stw-risk-head">
        <span className="stw-tag" data-tone={lv.tone}>
          <Icon aria-hidden />
          {lv.label}
        </span>
        <span className="stw-risk-kind">{KIND_LABEL[risk.kind]}</span>
        <span className="faint mono">{risk.requirementId ?? risk.spaceId}</span>
        <span className="faint num stw-risk-time" title={`首次 ${fmtRelative(risk.firstSeenAt)}`}>
          {fmtRelative(risk.lastSeenAt)}
        </span>
      </div>
      <h4 className="stw-risk-title">{risk.title}</h4>
      {!compact && <p className="stw-risk-detail">{risk.detail}</p>}
      {!compact && risk.evidence.length > 0 && (
        <div className="stw-risk-evidence">
          {risk.evidence.map((e) => (
            <a key={e.href} href={e.href} className="stw-link" onClick={(ev) => (ev.preventDefault(), jumpTo(e.href, risk.requirementId))}>
              {e.label}
              <ArrowUpRight aria-hidden />
            </a>
          ))}
        </div>
      )}
      {risk.state === 'snoozed' && (
        <p className="stw-risk-note">
          <Clock aria-hidden />
          已推迟，{risk.snoozedUntil ? `${hm(risk.snoozedUntil)} 再提醒` : '稍后再提醒'}
        </p>
      )}
      {risk.state === 'ignored' && (
        <p className="stw-risk-note">
          <EyeOff aria-hidden />
          已忽略，不再提醒
        </p>
      )}
      <div className="stw-risk-actions">
        {risk.state === 'open' &&
          risk.actions.slice(0, compact ? 1 : 2).map((a, i) => (
            <button key={a.label} type="button" className={`btn btn-sm${i === 0 && !compact ? ' btn-primary' : ''}`} onClick={() => act(a)}>
              {a.ask || a.commandId ? <Sparkles /> : <ArrowUpRight />}
              {a.label}
            </button>
          ))}
        <span style={{ flex: 1 }} />
        {risk.state === 'open' ? (
          <>
            <button ref={snoozeBtn} type="button" className="btn btn-ghost btn-sm" aria-haspopup="menu" disabled={busy} onClick={() => setMenu(true)}>
              <BellOff />
              稍后提醒
            </button>
            {!compact && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void setState('ignored')}>
                <EyeOff />
                忽略
              </button>
            )}
          </>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void setState('open')}>
            <BellRing />
            恢复提醒
          </button>
        )}
      </div>
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={snoozeBtn}
        placement="bottom-end"
        ariaLabel="什么时候再提醒"
        items={SNOOZE.map((s, i) => ({ id: s.id, label: s.label, icon: Clock, section: i === 0 ? '再提醒我' : undefined, onSelect: () => void setState('snoozed', s.ms ? new Date(Date.now() + s.ms).toISOString() : tomorrow930()) }))}
      />
    </article>
  )
}
