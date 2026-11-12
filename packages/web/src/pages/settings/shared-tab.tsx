import { Check, GitFork } from 'lucide-react'
import type { AgentRoleView, SpaceDetail } from '@taktflow/core'
import type { AsyncState } from '../../api'
import { AgentMark } from '../../components/agent-mark'
import { EmptyState, ErrorState, SkeletonRows } from '../../components/ui'
import { setQuery } from '../../lib/router'
import { selectorText } from './runtime/shared'
import { ROLE_ORIGIN } from './role-form'
import './shared-tab.css'

const SOURCE: Record<AgentRoleView['effective']['source'], string> = { role: '角色档案', 'space-default': '默认路由', builtin: '内置默认' }

/**
 * 共享资源（docs/design/30 §3）：代码仓库、技能、知识库都挂在空间上，所有角色共用；
 * 这一页一张表看全每个角色实际用了哪些（技能是提示词里点名的，知识库没限定就是全部）。
 */
/** roles：设置页取的角色列表（与角色 Tab 同一份）。 */
export function SharedTab({ space, roles: q }: { space?: SpaceDetail; roles: AsyncState<AgentRoleView[]> }) {
  if (q.error && !q.data) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} compact /></div>
  if (!space || !q.data) return <div className="card"><SkeletonRows rows={8} /></div>
  const roles = q.data
  if (!roles.length) return <div className="card"><EmptyState title="还没有角色" body="先在“角色”里建一个，这里会列出它用了哪些技能和知识库。" /></div>
  const skills = space.skills.map((s) => s.name)
  const kbs = space.knowledge.map((k) => k.id)
  const usesKb = (r: AgentRoleView, id: string) => (r.knowledge ? (r.knowledge.includes(id) ? 'yes' : 'no') : 'all')
  const count = (pred: (r: AgentRoleView) => boolean) => roles.filter(pred).length
  const open = (role: string) => setQuery({ tab: 'agents', name: role })

  return (
    <div className="shared">
      <section className="card shared-repos" aria-label="代码仓库">
        <GitFork aria-hidden />
        <span className="shared-repos-text">
          <b>{space.repos.length} 个代码仓库</b>
          <span className="faint">所有角色都能读；能写哪些路径看每个角色的写范围</span>
        </span>
        <span className="shared-repos-list">
          {space.repos.map((r) => (
            <span key={r.id} className="chip mono">
              {r.id}
            </span>
          ))}
        </span>
      </section>

      <div className="card shared-table-wrap">
        <table className="shared-table">
          <caption className="sr-only">每个角色用了哪些技能和知识库</caption>
          <thead>
            <tr className="shared-groups">
              <th rowSpan={2} className="shared-role-h">角色</th>
              <th rowSpan={2}>用什么跑</th>
              {skills.length > 0 && <th colSpan={skills.length} className="shared-group grp-start">技能</th>}
              {kbs.length > 0 && <th colSpan={kbs.length} className="shared-group grp-start">知识库</th>}
              <th rowSpan={2}>写范围</th>
            </tr>
            <tr className="shared-cols">
              {skills.map((s, i) => (
                <th key={s} className={`shared-col mono${i === 0 ? ' grp-start' : ''}`} title={space.skills.find((x) => x.name === s)?.description}>
                  <span>{s}</span>
                </th>
              ))}
              {kbs.map((k, i) => (
                <th key={k} className={`shared-col mono${i === 0 ? ' grp-start' : ''}`} title={space.knowledge.find((x) => x.id === k)?.description}>
                  <span>{k}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.role} className="shared-row pressable" onClick={() => open(r.role)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(r.role)}>
                <th scope="row">
                  <span className="shared-role">
                    <AgentMark state="idle" role={r.role} size={24} />
                    <span className="truncate">{r.title}</span>
                    <span className="faint mono">{r.role}</span>
                  </span>
                </th>
                <td className="shared-run">
                  <span className="mono truncate">{selectorText(r.effective.harness)}</span>
                  <span className="faint">{r.effective.source === 'role' ? ROLE_ORIGIN[r.origin] : SOURCE[r.effective.source]}</span>
                </td>
                {skills.map((s, i) => (
                  <td key={s} className={`shared-cell${i === 0 ? ' grp-start' : ''}`}>
                    {r.skills.includes(s) ? <Check className="shared-yes" aria-label="用" /> : <span className="shared-no" aria-label="不用" />}
                  </td>
                ))}
                {kbs.map((k, i) => {
                  const u = usesKb(r, k)
                  return (
                    <td key={k} className={`shared-cell${i === 0 ? ' grp-start' : ''}`}>
                      {u === 'yes' ? <Check className="shared-yes" aria-label="用" /> : u === 'all' ? <Check className="shared-all" aria-label="没限定，全部可读" /> : <span className="shared-no" aria-label="不用" />}
                    </td>
                  )
                })}
                <td className="shared-scope mono">{r.writeScope.length ? r.writeScope.join('  ') : <span className="faint">不能写</span>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="faint">用到的角色</th>
              <td />
              {skills.map((s, i) => {
                const n = count((r) => r.skills.includes(s))
                return (
                  <td key={s} className={`shared-cell num${n ? '' : ' unused'}${i === 0 ? ' grp-start' : ''}`} title={n ? undefined : '没有角色用它'}>
                    {n}
                  </td>
                )
              })}
              {kbs.map((k, i) => {
                const n = count((r) => usesKb(r, k) !== 'no')
                return (
                  <td key={k} className={`shared-cell num${n ? '' : ' unused'}${i === 0 ? ' grp-start' : ''}`} title={n ? undefined : '没有角色能读它'}>
                    {n}
                  </td>
                )
              })}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="shared-legend faint">
        <Check className="shared-yes" aria-hidden /> 角色里点名用 <Check className="shared-all" aria-hidden /> 角色没限定知识库，全部可读　点一行去改这个角色
      </p>
    </div>
  )
}
