import { useEffect } from 'react'
import { ArrowUpRight, GitBranch, ListChecks } from 'lucide-react'
import type { RoomMessage, Usage } from '@taktflow/core'
import { useAsync } from '../../../api'
import { KindIcon, StatusBadge } from '../../../components/ui'
import { TaktRuler } from '../../../components/takt'
import { fmtCost, fmtTokens } from '../../../lib/format'
import { Link } from '../../../lib/router'
import { NODE_STATUS, RUN_STATUS } from '../../../lib/status'
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
export function TaskCard({ m, pulse, onRoles }: { m: RoomMessage; pulse: number; onRoles?(runId: string, roles: string[]): void }) {
  const runId = m.refs?.taskRunId ?? m.refs?.runId
  const run = useAsync((ds) => (runId ? ds.run(runId) : Promise.reject(new Error('任务没有关联运行'))), [runId])
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
        {d && <StatusBadge meta={RUN_STATUS[d.run.status]} />}
      </header>
      {running && <TaktRuler ticks={24} running className="chat-task-ruler" />}
      {!d && !run.error && <p className="chat-task-empty faint">正在读取任务运行…</p>}
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
