import { useState } from 'react'
import { GitMerge, Undo2 } from 'lucide-react'
import type { DefectDetail, DefectMergeSuggestion } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { ReasonDialog, toast } from '../../components/ui'
import { actorName, fmtRelative } from '../../lib/format'
import { setQuery } from '../../lib/router'

type Decision = 'accept' | 'reject' | 'undo'

const STATUS: Record<DefectMergeSuggestion['status'], string> = {
  suggested: '待决定',
  accepted: '已合并',
  rejected: '不是同一个',
  undone: '已撤销',
}

const TITLE: Record<Decision, (other: string) => string> = {
  accept: (o) => `合并：把 ${o} 标为重复？`,
  reject: (o) => `${o} 不是同一个问题？`,
  undo: () => '撤销这次决定？',
}

/**
 * 合并建议（docs/design/21 §4）：系统只给建议（同一检查点 / 同一问题键 / 标题相近），人接受 / 拒绝，可撤销。
 * 接受时把建议里后一个缺陷标为前一个的重复。
 */
export function MergeCard({ d, suggestions, defects }: { d: DefectDetail; suggestions: DefectMergeSuggestion[]; defects: DefectDetail[] }) {
  const ds = useSource()
  const [pending, setPending] = useState<{ s: DefectMergeSuggestion; decision: Decision }>()
  const mine = suggestions.filter((s) => s.defects.includes(d.id))
  if (!mine.length) return null
  const title = (id: string) => defects.find((x) => x.id === id)?.title
  return (
    <section className="df-sec df-merges">
      <h3 className="df-h3">
        合并建议 <span className="faint df-h3-sub">只是建议，由人决定，可以撤销</span>
      </h3>
      {mine.map((s) => {
        const others = s.defects.filter((x) => x !== d.id)
        const [keep, dup] = s.defects
        const open = s.status === 'suggested' || s.status === 'undone'
        return (
          <div key={s.id} className={`df-merge st-${s.status}`}>
            <GitMerge className="df-merge-ic" aria-hidden />
            <div className="df-merge-main">
              <p className="df-merge-line">
                可能和
                {others.map((o) => (
                  <button key={o} type="button" className="df-merge-link" onClick={() => setQuery({ defect: o })}>
                    <span className="mono">{o}</span> {title(o)}
                  </button>
                ))}
                是同一个问题
                <span className={`df-merge-st st-${s.status}`}>{STATUS[s.status]}</span>
              </p>
              <p className="df-merge-reason faint">{s.reason}</p>
              {s.status === 'accepted' && (
                <p className="df-merge-reason">
                  <span className="mono">{dup}</span> 已标为 <span className="mono">{keep}</span> 的重复
                  {s.decidedBy && (
                    <span className="faint">
                      {' '}
                      · {actorName(s.decidedBy)} {fmtRelative(s.at)}
                    </span>
                  )}
                </p>
              )}
            </div>
            <div className="df-merge-act">
              {open ? (
                <>
                  <button type="button" className="btn btn-xs btn-primary" onClick={() => setPending({ s, decision: 'accept' })}>
                    合并
                  </button>
                  <button type="button" className="btn btn-xs" onClick={() => setPending({ s, decision: 'reject' })}>
                    不是同一个
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => setPending({ s, decision: 'undo' })}>
                  <Undo2 />
                  撤销
                </button>
              )}
            </div>
          </div>
        )
      })}
      <ReasonDialog
        open={Boolean(pending)}
        onClose={() => setPending(undefined)}
        title={pending ? TITLE[pending.decision](pending.s.defects[1] ?? '') : ''}
        description={pending?.decision === 'accept' ? `${pending.s.defects[1]} 会标为 ${pending.s.defects[0]} 的重复，只按 ${pending.s.defects[0]} 计入检出率；之后可以撤销。` : pending?.decision === 'undo' ? '恢复到做决定之前的状态；撤销本身也进质量日志。' : '记下判断依据，之后同样的建议不会再自动消失。'}
        confirmLabel={pending?.decision === 'accept' ? '确认合并' : '确认'}
        onSubmit={async (reason) => {
          if (!pending) return
          await ds.decideMerge(d.requirementId, pending.s.id, { decision: pending.decision, reason })
          invalidate()
          toast(pending.decision === 'accept' ? '已合并' : pending.decision === 'undo' ? '已撤销' : '已记下：不是同一个', { tone: 'success' })
        }}
      />
    </section>
  )
}
