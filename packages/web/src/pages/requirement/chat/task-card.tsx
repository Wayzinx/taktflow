import { useEffect } from 'react'
import { ArrowUpRight, GitBranch, ListChecks } from 'lucide-react'
import type { RoomMessage, Usage } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../../api'
import { HopChain, normReceipt, ReceiptRail, ResendButton } from '../../../components/receipt'
import { KindIcon, SkeletonRows, StatusBadge, toast } from '../../../components/ui'
import { TaktRuler } from '../../../components/takt'
import { fmtCost, fmtTokens } from '../../../lib/format'
import { Link } from '../../../lib/router'
import { NODE_STATUS, runStatusMeta } from '../../../lib/status'
import { ArtifactChip } from './message-refs'

function sumUsage(list: Array<Usage | undefined>): Usage | undefined {
  const xs = list.filter((u): u is Usage => Boolean(u))
  if (!xs.length) return undefined
  return xs.reduce((s, u) => ({ inputTokens: s.inputTokens + u.inputTokens, outputTokens: s.outputTokens + u.outputTokens, costUsd: (s.costUsd ?? 0) + (u.costUsd ?? 0) }), { inputTokens: 0, outputTokens: 0, costUsd: 0 } as Usage)
}

/**
 * 临时任务卡片：Lead 派发的任务就是一次普通运行，卡片显示每个子任务的状态和产物。
 * 群里提到这个任务（pulse 变化）时刷新；运行中再按两拍轮询一次，节点开始这类不发群消息的变化也能跟上。
 */
export function TaskCard({ m, pulse, onRoles, requirementId, resent, onJump }: { m: RoomMessage; pulse: number; onRoles?(runId: string, roles: string[]): void; requirementId?: string; resent?: string; onJump?(messageId: string): void }) {
  const ds = useSource()
  const runId = m.refs?.taskRunId ?? m.refs?.runId
  // 拒绝 / 过期 / 不确定 / 还没开始的派发没有运行：只画回执
  const run = useAsync((ds) => (runId ? ds.run(runId) : Promise.resolve(undefined)), [runId ?? ''])
  const receipt = m.receipt
  const status = receipt ? normReceipt(receipt.status) : undefined
  const problem = status === 'refused' || status === 'expired' || status === 'uncertain'
  const resend = async (reason: string) => {
    const next = await ds.resendRoomTask(requirementId ?? '', m.id, reason)
    invalidate()
    toast('已重发', { body: `Lead 会重新处理「${m.text}」，回执看新的任务卡片。`, action: onJump ? { label: '看新卡片', onClick: () => onJump(next.id) } : undefined })
  }
  const running = run.data?.run.status === 'running'
  const { reload } = run
  // 不放进 deps：换 key 会清空数据造成闪烁，reload 保留旧数据
  useEffect(() => {
    if (pulse) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse])
  useEffect(() => {
    if (!running) return
    const t = setInterval(reload, 2400)
    return () => clearInterval(t)
    // reload 每次渲染都是新函数，只跟 running 走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  const d = run.data
  const roles = d?.graph.nodes.filter((n) => n.status === 'running' && n.role).map((n) => n.role!).join(',') ?? ''
  useEffect(() => {
    if (d) onRoles?.(d.run.runId, roles ? roles.split(',') : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.run.runId, roles])
  const usage = d?.usage ?? sumUsage(d?.graph.nodes.map((n) => n.usage) ?? [])
  const branch = d ? Object.values(d.run.nodes).find((n) => n.worktree)?.worktree?.branch : undefined
  return (
    <article className={`chat-task${running ? ' live' : ''}`} aria-label={`临时任务：${m.text}`}>
      <header className="chat-task-head">
        <ListChecks aria-hidden="true" />
        <span className="chat-task-kicker">临时任务</span>
        <h4 className="chat-task-title truncate">{m.text}</h4>
        {d && <StatusBadge meta={runStatusMeta(d.run.status, d.interrupted)} />}
      </header>
      {receipt && (
        <div className={`chat-task-receipt${problem ? ' is-problem' : ''}`}>
          <ReceiptRail status={receipt.status} kind="task" />
          {(receipt.hops || receipt.chain?.length) && (status === 'refused' || (receipt.hops ?? 0) > 0) ? <HopChain hops={receipt.hops} chain={receipt.chain} refused={status === 'refused'} /> : null}
          {receipt.note && <p className="chat-task-note">{receipt.note}</p>}
          {problem && status !== 'refused' && (
            <div className="chat-task-resend">
              {resent ? (
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => onJump?.(resent)}>
                  已重发，看新卡片
                </button>
              ) : (
                <>
                  <span className="faint">{status === 'uncertain' ? '重发前先确认下面没有同名任务在跑。' : '30 分钟没有人接手。'}</span>
                  <ResendButton status={receipt.status} what="这个任务" onResend={resend} />
                </>
              )}
            </div>
          )}
        </div>
      )}
      {running && <TaktRuler ticks={24} running className="chat-task-ruler" />}
      {runId && !d && !run.error && (
        <div className="chat-task-empty">
          <SkeletonRows rows={2} />
        </div>
      )}
      {run.error && !d && <p className="chat-task-empty faint">{run.error.message}</p>}
      {d && (
        <ol className="chat-task-nodes">
          {d.graph.nodes.map((n) => {
            const outs = d.run.nodes[n.id]?.outputs ?? []
            return (
              <li key={n.id} className={`chat-task-node st-${n.status}`}>
                <KindIcon kind={n.kind} size={20} />
                <div className="chat-task-node-main">
                  <div className="chat-task-node-line">
                    <span className="chat-task-node-title truncate">{n.title}</span>
                    <span className="mono faint truncate">{[n.role, n.harness].filter(Boolean).join(' · ')}</span>
                  </div>
                  {outs.length > 0 && (
                    <div className="chat-refs">
                      {outs.map((a) => (
                        <ArtifactChip key={`${a.path}@${a.version ?? ''}`} a={a} />
                      ))}
                    </div>
                  )}
                </div>
                <StatusBadge meta={NODE_STATUS[n.status]} subtle />
              </li>
            )
          })}
        </ol>
      )}
      {d && (
        <footer className="chat-task-foot">
          {branch && (
            <span className="chat-task-meta">
              <GitBranch aria-hidden="true" />
              <span className="mono">{branch}</span>
            </span>
          )}
          {usage && (
            <span className="chat-task-meta mono">
              {fmtTokens(usage.inputTokens + usage.outputTokens)} tokens · {fmtCost(usage.costUsd)}
            </span>
          )}
          <span className="spacer" />
          <Link className="btn btn-sm btn-ghost" to={`/run/${d.run.runId}`}>
            打开运行
            <ArrowUpRight />
          </Link>
        </footer>
      )}
    </article>
  )
}
