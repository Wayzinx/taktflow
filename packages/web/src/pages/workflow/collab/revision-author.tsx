import { FilePen, Settings2 } from 'lucide-react'
import { useAsync, useMemberName } from '../../../api'
import { AgentMark } from '../../../components/agent-mark'
import { StewardMark } from '../../../components/identity'
import { Avatar } from '../../../components/ui'
import type { RevisionAuthor } from './revision-who'

/** 成员 id → 显示名，当前操作者显示成「你」。 */
export function usePersonName(): (id: string) => string {
  const member = useMemberName()
  const me = useAsync((ds) => ds.me().catch(() => undefined), []).data
  return (id) => (id === me?.id ? '你' : member(id))
}

export function AuthorMark({ who, size = 18 }: { who: RevisionAuthor; size?: number }) {
  const a = who.actor
  if (who.kind === 'steward') return <StewardMark size={size} state="done" />
  if (who.kind === 'agent' && a.type === 'agent') return <AgentMark state="done" role={a.role} size={size} label={who.name} />
  if (who.kind === 'external' || who.kind === 'system') {
    const Icon = who.kind === 'external' ? FilePen : Settings2
    return (
      <span className="wfc-author-icon" style={{ width: size, height: size }} role="img" aria-label={who.name}>
        <Icon />
      </span>
    )
  }
  return <Avatar name={who.name} id={a.type === 'human' ? a.id : undefined} size={size} />
}
