import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Laptop, RotateCw } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { useCrumbs } from '../../components/layout'
import { PageHeader, Skeleton } from '../../components/ui'
import { actingUser, subscribeActingUser } from '../../lib/acting-user'
import { Link, useLocation } from '../../lib/router'
import { splitSpace } from '../../lib/space'
import { TeamComposer } from './composer'
import { Conversation, JobStatus } from './conversation'
import { canPostTeam, nodeKey } from './model'
import { useTeam } from './use-team'
import './team.css'

export function TeamPage() {
  const { spaceId } = useLocation()
  const user = useSyncExternalStore(subscribeActingUser, () => actingUser(spaceId))
  useCrumbs([{ label: '管家', to: '/solo' }, { label: '空间讨论' }], [])
  return <TeamRoom key={JSON.stringify([spaceId, user])} spaceId={spaceId} user={user} />
}

function TeamRoom({ spaceId, user }: { spaceId?: string; user?: string }) {
  const root = useSource()
  const source = spaceId ? root.forSpace(spaceId) : root
  const isCurrent = useCallback(() => {
    const locationScope = splitSpace(location.pathname)
    return ['/steward', '/solo'].includes(locationScope.rest) && new URLSearchParams(location.search).get('room') === 'team' && locationScope.spaceId === spaceId && actingUser(spaceId) === user
  }, [spaceId, user])
  const team = useTeam(source, isCurrent)
  const viewer = useAsync(() => source.me(), [spaceId, user])
  const space = useAsync(() => source.space(), [spaceId, user])
  const workflows = useAsync(() => source.workflows(), [spaceId, user])
  const [writeDenied, setWriteDenied] = useState(false)
  const data = team.data
  const me = viewer.data
  const members = space.data?.members
  const nodes = data?.nodes ?? []
  const online = nodes.filter((node) => node.online).length
  const jobs = useMemo(() => new Map(data?.jobs.map((job) => [job.id, job])), [data])
  const messages = useMemo(() => data?.messages.slice().sort((left, right) => left.at.localeCompare(right.at)) ?? [], [data])
  const linked = new Set(messages.map((message) => message.jobId))
  const unlinked = data?.jobs.filter((job) => !linked.has(job.id)) ?? []
  const readOnly = source.mock ? '演示数据只读，不能发送。'
    : viewer.error ? '无法确认当前身份，刷新后再试。'
    : !me ? '确认空间身份后即可发送。'
    : !me.member ? '请联系空间所有者将你加入后再发送。'
    : writeDenied ? '当前身份没有发送权限，请确认空间成员角色。'
    : !canPostTeam(me, source.mock) ? '当前角色只能查看对话。' : undefined

  const refresh = () => {
    void team.refresh()
    viewer.reload()
    space.reload()
    workflows.reload()
    setWriteDenied(false)
  }
  return (
    <div className="page team-page">
      <PageHeader title="空间讨论" description="空间成员可在这里讨论、发起开发任务，查看来自已绑定渠道的消息。" actions={
        <button type="button" className="btn" onClick={refresh} disabled={team.loading && !data}><RotateCw aria-hidden /> 刷新</button>
      } />
      <div className="team-layout">
        <section className="card team-room" aria-labelledby="team-room-title">
          <div className="team-room-head">
            <h2 id="team-room-title">空间对话</h2>
            {me && <span>当前身份：<strong>{me.name}</strong></span>}
          </div>
          {team.error && <div className="team-load-error" role="alert">{data ? '刷新对话失败' : '无法读取空间对话'}：{team.error}</div>}
          {data ? (
            <>
              <Conversation messages={messages} jobs={jobs} memberName={(id) => members?.find((member) => member.id === id)?.name ?? id} />
              <TeamComposer source={source} nodes={nodes} workflows={workflows.data ?? []} workflowsLoading={workflows.loading} workflowsError={workflows.error}
                reloadWorkflows={workflows.reload} readOnly={readOnly} showMembers={!!me && !source.mock} isCurrent={isCurrent}
                onSnapshot={team.accept} onDenied={() => { setWriteDenied(true); viewer.reload(); void team.refresh() }} />
            </>
          ) : team.loading && !team.error ? <div className="team-loading" aria-label="正在读取空间对话" role="status"><Skeleton w="50%" h={14} /><Skeleton w="70%" h={14} /><Skeleton w="42%" h={14} /></div> : null}
        </section>
        <aside className="team-side" aria-label="开发资源">
          {!viewer.error && me?.member?.role === 'owner' && <section aria-labelledby="team-feishu-title">
            <div className="team-side-head"><h2 id="team-feishu-title">消息渠道</h2></div>
            <p>从飞书、GitHub Issue 或微信联系此空间的管家。</p>
            <Link to="/settings?tab=feishu" className="btn btn-sm">管理消息渠道</Link>
          </section>}
          <section aria-labelledby="team-nodes-title">
            <div className="team-side-head"><Laptop aria-hidden /><h2 id="team-nodes-title">开发机</h2>{data && <span className="num">{online} 台在线</span>}</div>
            {data && nodes.length > 0 && <ul className="team-nodes">
              {nodes.map((node) => <li key={nodeKey(node)}>
                <div><strong>{node.displayName ?? node.id}</strong><span className="team-node-harness mono">{node.harness}</span></div>
                <span className="team-node-state" data-online={node.online}>{node.online ? '在线' : '离线'}</span>
              </li>)}
            </ul>}
            {!data ? <p>{team.error ? '暂时无法读取开发机状态。' : <Skeleton w={120} h={14} />}</p> : !online && (
              <p>{nodes.length ? '开发机均离线。请检查执行节点是否正在运行并连接到当前空间服务。' : '还没有开发机。连接设备并上线后，即可选择「直接开发」。'}</p>
            )}
            <Link to="/devices" className="btn btn-sm team-devices-link">设备与 Agent</Link>
          </section>
          {unlinked.length > 0 && <section aria-labelledby="team-jobs-title">
            <div className="team-side-head"><h2 id="team-jobs-title">执行任务</h2></div>
            {unlinked.map((job) => <JobStatus key={job.id} job={job} />)}
          </section>}
        </aside>
      </div>
    </div>
  )
}
