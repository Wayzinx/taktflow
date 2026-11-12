import { useEffect, useRef, useState } from 'react'
import { Ban, Check, CircleAlert, Hourglass, RotateCcw, Shield, ShieldAlert, ShieldCheck, Undo2, X } from 'lucide-react'
import type { Proposal, ProposalStep } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { toast } from '../ui'
import { askSteward, previewWorkflowProposal } from '../../lib/ui-store'
import { confirmTargetOf, previewFor, ProposalStepView } from './proposal-step'
import './cards.css'
import { BeeGlyph } from '../identity'

const RISK = {
  low: { label: '低风险', icon: ShieldCheck, tone: 'success' },
  medium: { label: '中风险', icon: Shield, tone: 'waiting' },
  high: { label: '高风险', icon: ShieldAlert, tone: 'failed' },
} as const

const STATUS: Record<Proposal['status'], { label: string; tone: string }> = {
  pending: { label: '待你决定', tone: 'waiting' },
  applied: { label: '已执行', tone: 'success' },
  rejected: { label: '已拒绝', tone: 'skipped' },
  failed: { label: '执行失败', tone: 'failed' },
  reverted: { label: '已撤销', tone: 'skipped' },
  stale: { label: '基线已变化', tone: 'stale' },
}

const REJECT_REASONS = ['改动太大', '现在不需要', '内容不对', '换个做法']

function useNow(ms: number, on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms, on])
  return now
}

function fmtLeft(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
  const s = Math.max(0, Math.floor(ms / 1000) % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 执行成功的对勾：圆 + 勾描边 300ms（reduced-motion 只淡入）。 */
function DoneCheck() {
  return (
    <svg className="stw-check" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M7.5 12.5l3 3 6-6.5" />
    </svg>
  )
}

/**
 * 变更提案卡（docs/design/22 §1.5）：标题、风险、为什么、每步预览（参数可直接改）、批准 / 拒绝（可填原因）/ 撤销倒计时。
 * 批准绑定 hash；改过参数时把整份 steps 带上（服务端重算 hash 并标 edited）；409 时显示"基线已变化"。
 */
export function ProposalCard({ proposal, onChange, animate }: { proposal: Proposal; onChange: (p: Proposal) => void; animate?: boolean }) {
  const ds = useSource()
  const [steps, setSteps] = useState<ProposalStep[]>(proposal.steps)
  const [edited, setEdited] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'reject' | 'undo'>()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [justApplied, setJustApplied] = useState(false)
  const [typed, setTyped] = useState('')
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const p = proposal
  const pending = p.status === 'pending'
  const undoLeft = p.status === 'applied' && p.undoUntil ? Date.parse(p.undoUntil) - Date.now() : 0
  const now = useNow(undoLeft < 3600_000 ? 1000 : 30_000, p.status === 'applied' && undoLeft > 0)
  const left = p.undoUntil ? Date.parse(p.undoUntil) - now : 0

  useEffect(() => {
    if (!edited) setSteps(p.steps)
  }, [p.steps, edited])
  useEffect(() => {
    if (rejecting) reasonRef.current?.focus()
  }, [rejecting])

  // 决定之后画布上的幽灵预览就没意义了
  const clearGhost = () => p.steps.some((s) => s.kind === 'workflow') && previewWorkflowProposal(undefined)
  const approve = async () => {
    setBusy('approve')
    try {
      const next = await ds.approveProposal(p.id, { hash: p.hash, steps: edited ? steps : undefined })
      onChange(next)
      setJustApplied(true)
      clearGhost()
      // 改的可能正是旁边页面上的数据（设置页成员、需求列表），新出现的行会闪一下；侧栏会话的「待决定」和管家接着回复的状态也变了：让页面重新取数
      invalidate()
      toast(`已执行：${p.title}`, { tone: 'success', body: next.results?.map((r) => r.message).join('；'), undo: next.undoUntil ? () => void undo(next) : undefined })
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status === 409) onChange({ ...p, status: 'stale', error: err.message })
      else toast('执行失败', { tone: 'failed', body: err.message })
    } finally {
      setBusy(undefined)
    }
  }
  const reject = async () => {
    setBusy('reject')
    try {
      onChange(await ds.rejectProposal(p.id, reason.trim() || undefined))
      setRejecting(false)
      clearGhost()
      invalidate()
      toast('已拒绝提案', { body: reason.trim() ? `原因：${reason.trim()}` : '管家会记住这次的判断' })
    } catch (e) {
      toast('操作失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(undefined)
    }
  }
  async function undo(target = p) {
    setBusy('undo')
    try {
      onChange(await ds.undoProposal(target.id, '撤销管家提案'))
      setJustApplied(false)
      invalidate()
      toast(`已撤销：${target.title}`, { tone: 'success' })
    } catch (e) {
      toast('撤销失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(undefined)
    }
  }

  const risk = RISK[p.risk]
  const RiskIcon = risk.icon
  // 高风险 / 删除类：批准前手动输入目标确认（服务端校验见 protocolChangeRequests：ProposalDecisionRequest.confirm）
  const confirmTarget = pending ? confirmTargetOf({ risk: p.risk, steps }) : undefined
  const confirmed = !confirmTarget || typed.trim() === confirmTarget
  const st = STATUS[p.status]
  return (
    <section className={`stw-proposal${animate ? ' stw-in' : ''}`} data-status={p.status} aria-label={`提案：${p.title}`} data-steward-anchor={p.id}>
      <header className="stw-proposal-head">
        {p.status === 'applied' ? justApplied ? <DoneCheck /> : <Check className="stw-proposal-ok" aria-hidden /> : <BeeGlyph className="stw-proposal-icon" aria-hidden />}
        <div className="stw-proposal-titles">
          <h3 className="stw-proposal-title">{p.title}</h3>
          <div className="stw-proposal-meta">
            <span className="stw-tag" data-tone={risk.tone}>
              <RiskIcon aria-hidden />
              {risk.label}
            </span>
            <span className="stw-tag" data-tone={st.tone}>
              {p.status === 'pending' ? <Hourglass aria-hidden /> : p.status === 'failed' || p.status === 'stale' ? <CircleAlert aria-hidden /> : null}
              {p.auto && p.status === 'applied' ? '已自动执行' : st.label}
            </span>
            {(p.edited || edited) && <span className="stw-tag">已修改</span>}
            <span className="faint">{p.steps.length} 步</span>
          </div>
        </div>
      </header>
      <p className="stw-proposal-sum">{p.summary}</p>
      <ol className="stw-steps">
        {steps.map((s, i) => (
          <ProposalStepView
            key={i}
            index={i}
            step={s}
            original={p.steps[i]}
            preview={previewFor(p, i)}
            proposalId={p.id}
            threadId={p.threadId}
            editable={pending && !busy}
            onChange={(next) => {
              setEdited(true)
              setSteps((cur) => cur.map((x, j) => (j === i ? next : x)))
            }}
          />
        ))}
      </ol>
      {p.reason && p.status === 'rejected' && <p className="stw-proposal-note">拒绝原因：{p.reason}</p>}
      {(p.error || p.status === 'stale') && <p className="stw-proposal-note" data-tone="failed">{p.error ?? '批准前基线已经变了，需要管家基于新版本重新生成。'}</p>}

      <div className="expand" data-open={rejecting}>
        <div>
          <div className="stw-reject">
            <div className="stw-reject-chips">
              {REJECT_REASONS.map((r) => (
                <button key={r} type="button" className="suggest-chip pressable" aria-pressed={reason === r} tabIndex={rejecting ? 0 : -1} onClick={() => setReason(r)}>
                  {r}
                </button>
              ))}
            </div>
            <textarea ref={reasonRef} className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="说说为什么（可选），管家下次会参考" tabIndex={rejecting ? 0 : -1} />
          </div>
        </div>
      </div>

      <footer className="stw-proposal-foot">
        {pending && !rejecting && confirmTarget && (
          <label className="stw-confirm">
            <span>
              这是不可逆或高风险操作，输入 <code className="mono">{confirmTarget}</code> 确认
            </span>
            <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmTarget} aria-label={`输入 ${confirmTarget} 确认`} autoComplete="off" spellCheck={false} />
          </label>
        )}
        {pending && !rejecting && (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void approve()} disabled={!!busy || !confirmed} title={confirmed ? undefined : '先输入目标确认'}>
              <Check />
              {busy === 'approve' ? '正在执行' : edited ? '按修改后批准' : '批准并执行'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setRejecting(true)} disabled={!!busy}>
              <X />
              拒绝
            </button>
          </>
        )}
        {pending && rejecting && (
          <>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void reject()} disabled={!!busy}>
              <Ban />
              确认拒绝
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejecting(false)}>
              取消
            </button>
          </>
        )}
        {p.status === 'applied' && left > 0 && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => void undo()} disabled={!!busy}>
              <Undo2 />
              撤销
            </button>
            <span className="faint num">还可撤销 {fmtLeft(left)}</span>
          </>
        )}
        {(p.status === 'stale' || p.status === 'failed') && (
          <button type="button" className="btn btn-sm" onClick={() => askSteward(`基于最新版本重新生成提案「${p.title}」`)}>
            <RotateCcw />
            让管家重新生成
          </button>
        )}
      </footer>
    </section>
  )
}
