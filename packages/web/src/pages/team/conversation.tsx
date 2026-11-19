import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ClipboardList, CircleAlert, GitBranch, MessagesSquare } from 'lucide-react'
import type { TeamJob, TeamMessage } from '../../api/team'
import { StewardMark } from '../../components/identity'
import { Avatar } from '../../components/ui'
import { fmtDateTime } from '../../lib/format'
import { Link } from '../../lib/router'

const STATUS = { queued: '排队中', running: '运行中', succeeded: '已成功', failed: '已失败' } satisfies Record<TeamJob['status'], string>

export function JobStatus({ job }: { job: TeamJob }) {
  const result = typeof job.result === 'string' ? job.result : job.result == null ? '' : JSON.stringify(job.result, null, 2)
  return (
    <div className="team-job">
      <div className="team-job-meta">
        <span className="team-job-state" data-state={job.status}>{STATUS[job.status]}</span>
        <span className="mono">{job.nodeId} · {job.harness}</span>
      </div>
      {result && <pre className="team-job-result">{result}</pre>}
    </div>
  )
}

export function Conversation({ messages, jobs, memberName }: { messages: TeamMessage[]; jobs: Map<string, TeamJob>; memberName: (id: string) => string }) {
  const view = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  useLayoutEffect(() => {
    const el = view.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, jobs])

  if (!messages.length) return (
    <div className="team-empty">
      <MessagesSquare aria-hidden />
      <h3>还没有团队消息</h3>
      <p>问一个问题，或选择开发方式发起任务。对话和结果会留在当前空间。</p>
    </div>
  )

  return (
    <div className="team-thread">
      <div className="team-log" role="log" aria-label="空间消息" tabIndex={0} ref={view} onScroll={(event) => {
        const el = event.currentTarget
        const next = el.scrollHeight - el.scrollTop - el.clientHeight < 36
        pinned.current = next
        setAtBottom(next)
      }}>
        <ol>
          {messages.map((message) => {
            const steward = message.role === 'steward'
            const job = message.jobId ? jobs.get(message.jobId) : undefined
            return (
              <li className="team-message" key={message.id}>
                <span className="team-avatar" data-steward={steward}>{steward ? <StewardMark size={24} /> : <Avatar name={memberName(message.author)} id={message.author} size={24} />}</span>
                <div className="team-message-content">
                  <div className="team-message-meta">
                    <strong>{steward ? '空间管家' : memberName(message.author)}</strong>
                    <time dateTime={message.at}>{fmtDateTime(message.at)}</time>
                  </div>
                  <p>{message.text}</p>
                  {(message.requirementId || message.runId) && <div className="team-message-links">
                    {message.requirementId && <Link to={`/req/${encodeURIComponent(message.requirementId)}`} className="btn btn-sm"><ClipboardList aria-hidden /> 需求 <span className="mono">{message.requirementId}</span></Link>}
                    {message.runId && <Link to={`/run/${encodeURIComponent(message.runId)}`} className="btn btn-sm"><GitBranch aria-hidden /> 运行 <span className="mono">{message.runId}</span></Link>}
                  </div>}
                  {job ? <JobStatus job={job} /> : message.jobId ? <div className="team-missing-job"><CircleAlert aria-hidden /> 暂未收到任务状态</div> : null}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
      {!atBottom && <button type="button" className="btn btn-sm team-latest" onClick={() => {
        const el = view.current
        if (el) el.scrollTop = el.scrollHeight
        pinned.current = true
        setAtBottom(true)
      }}><ArrowDown aria-hidden /> 回到最新</button>}
    </div>
  )
}
