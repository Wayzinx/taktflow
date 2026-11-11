import { FolderGit2, Plus, UserPlus, X } from 'lucide-react'
import type { SpaceMember } from '@taktflow/core'
import { Avatar } from '../ui'
import type { MemberRow, RepoRow, SpaceForm } from './model'

let seq = 1
const ROLES: Array<{ id: SpaceMember['role']; label: string }> = [
  { id: 'maintainer', label: '维护者' },
  { id: 'member', label: '成员' },
  { id: 'viewer', label: '只读' },
]

/** 第 3 步：仓库与成员，都可以跳过；创建者自动成为 owner。 */
export function StepTeam({ f, set, me }: { f: SpaceForm; set: (p: Partial<SpaceForm>) => void; me?: { id: string; name: string } }) {
  const setRepo = (key: number, p: Partial<RepoRow>) => set({ repos: f.repos.map((r) => (r.key === key ? { ...r, ...p } : r)) })
  const setMember = (key: number, p: Partial<MemberRow>) => set({ members: f.members.map((m) => (m.key === key ? { ...m, ...p } : m)) })
  return (
    <div className="sc-step">
      <section className="sc-section">
        <header className="sc-section-head">
          <FolderGit2 aria-hidden />
          <span>仓库</span>
          <span className="ov-field-hint">本地路径或 git 地址，加默认分支</span>
        </header>
        {f.repos.map((r) => (
          <div key={r.key} className="sc-row stagger-item">
            <input className="input mono" value={r.loc} onChange={(e) => setRepo(r.key, { loc: e.target.value })} placeholder="git@github.com:acme/shop-web.git 或 ../shop-web" aria-label="仓库地址" autoFocus={!r.loc} />
            <input className="input mono sc-branch" value={r.branch} onChange={(e) => setRepo(r.key, { branch: e.target.value })} placeholder="main" aria-label="默认分支" />
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="移除仓库" title="移除" onClick={() => set({ repos: f.repos.filter((x) => x.key !== r.key) })}>
              <X />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm btn-ghost sc-add" onClick={() => set({ repos: [...f.repos, { key: seq++, loc: '', branch: 'main' }] })}>
          <Plus />
          添加仓库
        </button>
      </section>
      <section className="sc-section">
        <header className="sc-section-head">
          <UserPlus aria-hidden />
          <span>成员</span>
          <span className="ov-field-hint">之后也能在空间设置里加</span>
        </header>
        <div className="sc-row sc-me">
          <Avatar name={me?.name ?? '你'} id={me?.id} size={22} />
          <span className="truncate">{me?.name ?? '你'}</span>
          <span className="sc-role-fixed">owner · 创建者</span>
        </div>
        {f.members.map((m) => (
          <div key={m.key} className="sc-row stagger-item">
            <input className="input" value={m.name} onChange={(e) => setMember(m.key, { name: e.target.value })} placeholder="姓名" aria-label="成员姓名" autoFocus={!m.name} />
            <input className="input" type="email" value={m.email} onChange={(e) => setMember(m.key, { email: e.target.value })} placeholder="邮箱（选填）" aria-label="成员邮箱" />
            <select className="select sc-role" value={m.role} onChange={(e) => setMember(m.key, { role: e.target.value as SpaceMember['role'] })} aria-label="权限">
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="移除成员" title="移除" onClick={() => set({ members: f.members.filter((x) => x.key !== m.key) })}>
              <X />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm btn-ghost sc-add" onClick={() => set({ members: [...f.members, { key: seq++, name: '', email: '', role: 'member' }] })}>
          <Plus />
          添加成员
        </button>
      </section>
    </div>
  )
}
