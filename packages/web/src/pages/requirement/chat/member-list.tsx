import type { LeadPresence, RoomMember } from '@taktflow/core'
import { LeadLight } from '../../../components/lead-light'
import { StatusDot } from '../../../components/ui'
import { MemberAvatar } from './message-item'

const GROUPS: Array<{ kind: RoomMember['kind']; label: string }> = [
  { kind: 'human', label: '真人' },
  { kind: 'lead', label: 'Lead' },
  { kind: 'agent', label: '子 Agent' },
]

/** 成员栏：按 真人 / Lead / 子 Agent 分组；点名字把 @id 插进输入框。busy 是正在干活的成员 id。 */
export function MemberList({ members, busy, lead, onMention }: { members: RoomMember[]; busy: Set<string>; lead?: LeadPresence; onMention(id: string): void }) {
  return (
    <nav className="chat-members" aria-label="群成员">
      <div className="chat-members-head">
        <span className="section-label">成员</span>
        <span className="mono faint">{members.length}</span>
      </div>
      {GROUPS.map((g) => {
        const list = members.filter((m) => m.kind === g.kind)
        if (!list.length) return null
        return (
          <section key={g.kind} className="chat-members-group">
            <h4 className="chat-members-label">{g.label}</h4>
            <ul>
              {list.map((m) => (
                <li key={m.id}>
                  <button className="chat-member" onClick={() => onMention(m.id)} title={`@${m.id}`}>
                    <MemberAvatar kind={m.kind} name={m.name} />
                    <span className="chat-member-text">
                      <span className="chat-member-name truncate">{m.name}</span>
                      {m.role && <span className="chat-member-role truncate">{m.role}</span>}
                    </span>
                    {m.kind === 'lead' && <LeadLight presence={lead} />}
                    {m.kind !== 'lead' && busy.has(m.id) && (
                      <span className="chat-member-busy" title="正在执行任务">
                        <StatusDot tone="running" pulse />
                        <span className="sr-only">正在执行任务</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </nav>
  )
}
