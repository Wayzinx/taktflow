import { useState } from 'react'
import { CheckCheck, MessageSquareText, ScrollText, TriangleAlert } from 'lucide-react'
import type { GraphNode } from '@taktflow/core'
import { invalidate, useAsync, useSource, type NodeView } from '../../api'
import { toast } from '../../components/ui'
import { navigate, setQuery } from '../../lib/router'

/**
 * 节点抽屉头部的"目标 / 小结"两行与操作：执行详情（跳 Trace）、告诉 Lead 怎么改（跳需求群并预填）、
 * 确认通过（只在这个节点有待审批时出现；审批对象已有新版本时提示过期）。
 */
export function NodeBrief({ d, graphNode, runId, requirementId, title, liveTick }: { d?: NodeView; graphNode?: GraphNode; runId: string; requirementId: string; title: string; liveTick: number }) {
  const ds = useSource()
  const nodeId = d?.state.id ?? graphNode?.id
  const goal = d?.goal ?? graphNode?.goal
  const summary = d?.summary ?? d?.state.summary ?? graphNode?.summary
  const waiting = (d?.state.status ?? graphNode?.status) === 'waiting_human'
  const att = useAsync((s) => (waiting ? s.attention(true) : Promise.resolve([])), [runId, nodeId, waiting, liveTick])
  const pending = att.data?.find((a) => a.runId === runId && a.nodeId === nodeId && !a.answeredAt && a.form === 'approve')
  const [busy, setBusy] = useState(false)

  if (!nodeId) return null

  const tellLead = () => {
    const text = `关于「${title}」（${nodeId}）：`
    navigate(`/req/${encodeURIComponent(requirementId)}?tab=chat&compose=${encodeURIComponent(text)}`)
  }

  const approve = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await ds.answer(pending.requestId, { decision: 'approve' })
      toast('已确认通过', { body: <span className="mono">{nodeId}</span>, tone: 'success' })
      invalidate()
    } catch (e) {
      toast('确认失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="node-brief">
      {(goal || summary) && (
        <dl className="node-brief-lines">
          {goal && (
            <>
              <dt>目标</dt>
              <dd title={goal}>{goal}</dd>
            </>
          )}
          {summary && (
            <>
              <dt>小结</dt>
              <dd title={summary}>{summary}</dd>
            </>
          )}
        </dl>
      )}
      <div className="node-brief-actions">
        <button type="button" className="btn btn-sm" onClick={() => setQuery({ dtab: 'trace' })}>
          <ScrollText />
          执行详情
        </button>
        <button type="button" className="btn btn-sm" onClick={tellLead} title="跳到需求群，输入框里预填这个节点">
          <MessageSquareText />
          告诉 Lead 怎么改
        </button>
        {pending && (
          <>
            {pending.stale && (
              <span className="node-brief-stale" title={pending.boundTo?.map((r) => `${r.path}@v${r.version}`).join(', ')}>
                <TriangleAlert aria-hidden />
                审批对象已更新
              </span>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={approve} disabled={busy} title={pending.ask}>
              <CheckCheck />
              {busy ? '提交中…' : '确认通过'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
