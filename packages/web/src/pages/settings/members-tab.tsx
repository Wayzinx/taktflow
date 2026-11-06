import { useEffect, useState } from 'react'
import { Plus, Trash2, Users } from 'lucide-react'
import type { SpaceDetail, SpaceMember } from '@taktflow/core'
import { useSource } from '../../api'
import { Avatar, EmptyState, ReasonDialog, SkeletonRows, toast } from '../../components/ui'
import { COMMON_DUTIES, DutiesEditor } from './duties-editor'

const ROLES: Array<{ id: SpaceMember['role']; label: string; can: string }> = [
  { id: 'owner', label: 'owner', can: '全部权限，含成员与绑定仓库' },
  { id: 'maintainer', label: 'maintainer', can: '改 workflow 与配置、取消运行' },
  { id: 'member', label: 'member', can: '发起运行、审批、在群里派活' },
  { id: 'viewer', label: 'viewer', can: '只读' },
]

export function MembersTab({ space, onSaved }: { space?: SpaceDetail; onSaved: () => void }) {
  const ds = useSource()
  const [draft, setDraft] = useState<SpaceMember[]>([])
  const [newId, setNewId] = useState('')
  const [newRole, setNewRole] = useState<SpaceMember['role']>('member')
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const base = JSON.stringify(space?.members ?? [])
  useEffect(() => setDraft(space?.members ?? []), [base])
  const dirty = JSON.stringify(draft) !== base

  if (!space) return <div className="card"><SkeletonRows rows={5} /></div>

  const owners = draft.filter((m) => m.role === 'owner').length
  const idTaken = draft.some((m) => m.id === newId.trim())
  const knownDuties = [...new Set(draft.flatMap((m) => m.duties ?? []))]
  const setDuties = (i: number, duties: string[]) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, duties: duties.length ? duties : undefined } : x)))

  function add() {
    const id = newId.trim()
    if (!id || idTaken) return
    setDraft((d) => [...d, { id, name: id, role: newRole }])
    setNewId('')
  }

  // 由 ReasonDialog 调用：服务端要求原因（写进空间审计）；失败时抛错，消息留在对话框里
  async function save(reason: string) {
    setBusy(true)
    try {
      await ds.setMembers(draft, reason)
      toast('成员已更新', { body: '已写回 takt.config.json 的 members。' })
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-split">
      <div className="card space-main-card">
        <div className="card-head">
          <span className="card-title">成员</span>
          <span className="faint num">{draft.length}</span>
        </div>
        {draft.length === 0 ? (
          <EmptyState compact icon={Users} title="还没有成员" hint="至少需要一位 owner。" />
        ) : (
          <ul className="member-list">
            {draft.map((m, i) => (
              <li key={m.id} className="member-row">
                <Avatar name={m.name} size={28} />
                <div className="member-text">
                  <span className="member-name">{m.name}</span>
                  <span className="faint mono">{m.email ?? m.id}</span>
                </div>
                <DutiesEditor name={m.name} value={m.duties ?? []} known={knownDuties} onChange={(next) => setDuties(i, next)} />
                <select
                  className="select select-sm"
                  aria-label={`${m.name} 的角色`}
                  value={m.role}
                  onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, role: e.target.value as SpaceMember['role'] } : x)))}
                >
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`移除 ${m.name}`}
                  title={m.role === 'owner' && owners === 1 ? '最后一位 owner 不能移除' : `移除 ${m.name}`}
                  disabled={m.role === 'owner' && owners === 1}
                  onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="member-add"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input className="input" placeholder="成员 id，例如 zhang" aria-label="新成员 id" value={newId} onChange={(e) => setNewId(e.target.value)} />
          <select className="select" aria-label="新成员角色" value={newRole} onChange={(e) => setNewRole(e.target.value as SpaceMember['role'])}>
            {ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <button className="btn" type="submit" disabled={!newId.trim() || idTaken}>
            <Plus />
            添加
          </button>
        </form>
        {idTaken && <p className="field-error">{newId.trim()} 已经是成员了。</p>}
        {dirty && (
          <div className="save-bar">
            <span>有未保存的变更{owners === 0 && '：至少保留一位 owner'}</span>
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setDraft(space.members)} disabled={busy}>
              放弃
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setAsking(true)} disabled={busy || owners === 0}>
              保存成员
            </button>
          </div>
        )}
        <ReasonDialog open={asking} onClose={() => setAsking(false)} title="保存成员变更" description="写回 takt.config.json 的 members，并记入空间审计。" confirmLabel="保存成员" onSubmit={save} />
      </div>
      <aside className="space-aside">
        <div className="section-label">角色与权限</div>
        <dl className="role-legend">
          {ROLES.map((r) => (
            <div key={r.id}>
              <dt className="mono">{r.label}</dt>
              <dd>{r.can}</dd>
            </div>
          ))}
        </dl>
        <div className="section-label">职责</div>
        <p>
          节点属性里的"负责人"写职责标签（如 <span className="mono">rd</span>），这个节点产生的待办会自动派给 duties 含此标签的成员，待办页可以筛"派给我"。
        </p>
        <dl className="role-legend">
          {COMMON_DUTIES.map((d) => (
            <div key={d.id}>
              <dt className="mono">{d.id}</dt>
              <dd>
                {d.label}
                {draft.some((m) => m.duties?.includes(d.id)) ? ` · ${draft.filter((m) => m.duties?.includes(d.id)).map((m) => m.name).join('、')}` : ' · 暂无成员'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="faint space-aside-note">
          命令行：<span className="mono">takt member add &lt;id&gt; --role member</span>
        </p>
      </aside>
    </div>
  )
}
