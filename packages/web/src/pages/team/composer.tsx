import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Lock, MessageCircle, RotateCw, Send, Terminal, Workflow } from 'lucide-react'
import type { WorkflowSummary } from '@taktflow/core'
import type { DataSource } from '../../api/source'
import type { TeamMode, TeamNode, TeamPost, TeamSnapshot } from '../../api/team'
import { Link } from '../../lib/router'
import { Segmented } from '../../components/ui'
import { initialDraft, nodeKey, teamPost } from './model'
import { denied } from './use-team'

const MODES = [
  { value: 'chat', label: '聊天', icon: MessageCircle },
  { value: 'workflow', label: '编排开发', icon: Workflow },
  { value: 'vibe', label: '直接开发', icon: Terminal },
] satisfies Array<{ value: TeamMode; label: string; icon: typeof Workflow }>

const PROMPT: Record<TeamMode, string> = {
  chat: '向团队 Agent 提问，或留下要同步的信息…',
  workflow: '描述需求、交付目标和验收标准…',
  vibe: '描述要在开发机上完成的任务…',
}

const SEND_TIMEOUT_MS = 60_000
const SLOW_MS = 3_000
const requestId = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

interface Props {
  source: DataSource
  nodes: TeamNode[]
  workflows: WorkflowSummary[]
  workflowsLoading: boolean
  workflowsError?: Error
  reloadWorkflows: () => void
  readOnly?: string
  showMembers: boolean
  isCurrent: () => boolean
  onSnapshot: (snapshot: TeamSnapshot) => void
  onDenied: () => void
}

export function TeamComposer({ source, nodes, workflows, workflowsLoading, workflowsError, reloadWorkflows, readOnly, showMembers, isCurrent, onSnapshot, onDenied }: Props) {
  const [draft, setDraft] = useState(initialDraft)
  const [attempt, setAttempt] = useState<TeamPost>()
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  const [slow, setSlow] = useState(false)
  const active = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => active.current?.abort(), [])

  const send = async (payload: TeamPost) => {
    if (active.current || readOnly || !isCurrent()) return
    const controller = new AbortController()
    active.current = controller
    setAttempt(payload)
    setSending(true)
    setSlow(false)
    setError(undefined)
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_MS)
    const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS)
    try {
      const snapshot = await source.postTeamMessage(payload, AbortSignal.any([controller.signal, timeout]))
      if (controller.signal.aborted || !isCurrent()) return
      onSnapshot(snapshot)
      setDraft((current) => ({ ...current, text: '' }))
      setAttempt(undefined)
    } catch (error) {
      if (controller.signal.aborted || !isCurrent()) return
      if (denied(error)) onDenied()
      setError(timeout.aborted ? '等待服务响应超时。请求可能已被收到。' : error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(slowTimer)
      active.current = undefined
      if (!controller.signal.aborted && isCurrent()) setSending(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (attempt || readOnly || active.current || !isCurrent()) return
    const payload = teamPost(draft, workflows, nodes, requestId())
    if (payload) void send(payload)
  }
  const online = nodes.some((node) => node.online)
  const selectedWorkflow = workflows.some((workflow) => workflow.id === draft.workflowId) ? draft.workflowId : ''
  const selectedNode = nodes.some((node) => node.online && nodeKey(node) === draft.nodeKey) ? draft.nodeKey : ''
  const locked = !!attempt || !!readOnly

  return (
    <form className="team-composer" onSubmit={submit} aria-label="发送空间消息">
      <div className="team-mode-row">
        <Segmented value={draft.mode} onChange={(mode) => setDraft((current) => ({ ...current, mode }))} ariaLabel="消息模式" options={MODES.map((option) => ({ ...option, disabled: !!attempt }))} />
        {readOnly && <span className="team-readonly"><Lock aria-hidden /> 只读</span>}
      </div>
      {draft.mode === 'workflow' && (
        <div className="team-target">
          <label htmlFor="team-workflow">流水线</label>
          <select id="team-workflow" className="select" value={selectedWorkflow} disabled={!!attempt || workflows.length === 0} onChange={(event) => setDraft({ ...draft, workflowId: event.target.value })}>
            <option value="">选择流水线</option>
            {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.title} · {workflow.id}</option>)}
          </select>
          {workflowsError ? <p role="alert">无法加载流水线。<button type="button" className="btn btn-sm" onClick={reloadWorkflows}>重试</button></p>
            : workflowsLoading && workflows.length === 0 ? <p role="status">正在读取流水线…</p>
            : workflows.length === 0 ? <p>当前空间没有流水线。<Link to="/workflows">查看流水线</Link></p> : null}
        </div>
      )}
      {draft.mode === 'workflow' && <label><input type="checkbox" checked={!!draft.includeDiscussion} disabled={locked} onChange={event => setDraft({ ...draft, includeDiscussion: event.target.checked })} /> 将最近 8 条空间消息附入需求</label>}
      {draft.mode === 'vibe' && (
        <div className="team-target">
          <label htmlFor="team-node">开发机与 Harness</label>
          <select id="team-node" className="select" value={selectedNode} disabled={!!attempt || !online} onChange={(event) => setDraft({ ...draft, nodeKey: event.target.value })}>
            <option value="">选择在线开发机</option>
            {nodes.map((node) => <option key={nodeKey(node)} value={nodeKey(node)} disabled={!node.online}>{node.id} · {node.harness} · {node.online ? '在线' : '离线'}</option>)}
          </select>
          {!online && <p>没有在线开发机。请先连接执行节点。</p>}
        </div>
      )}
      <textarea className="textarea team-textarea" aria-label="消息内容" rows={3} value={draft.text} placeholder={PROMPT[draft.mode]} disabled={locked} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
      <div className="team-composer-footer">
        {readOnly ? <span>{readOnly} {showMembers && <Link to="/settings?tab=members">空间成员</Link>}</span> : <span>本空间成员可见</span>}
        <button className="btn btn-primary" type="submit" disabled={locked || !teamPost(draft, workflows, nodes, '')}>
          <Send aria-hidden /> 发送
        </button>
      </div>
      {sending && <p className="team-send-note" role="status">{slow ? '服务响应较慢，仍在等待。无需再次提交。' : '正在提交消息…'}</p>}
      {error && attempt && (
        <div className="team-send-error">
          <p role="alert">{error} {!readOnly && '重试会使用同一请求编号。'}</p>
          <div className="team-actions">
            <button className="btn btn-sm" type="button" disabled={!!readOnly} onClick={() => void send(attempt)}><RotateCw aria-hidden /> 重试</button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => { setAttempt(undefined); setError(undefined) }}>返回草稿</button>
          </div>
        </div>
      )}
    </form>
  )
}
