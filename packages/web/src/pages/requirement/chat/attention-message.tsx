import { UserRoundCheck } from 'lucide-react'
import type { AttentionItem, RoomMessage } from '@taktflow/core'
import { AttentionCard } from '../../../components/attention-card'
import { Link } from '../../../lib/router'

/** 群里的待办卡片：直接复用待办页的卡片，审批 / 回答 / 裁决都能在群里完成。 */
export function AttentionMessage({ m, items }: { m: RoomMessage; items?: AttentionItem[] }) {
  const item = m.refs?.requestId ? items?.find((a) => a.requestId === m.refs?.requestId) : undefined
  if (item) {
    return (
      <div className={`chat-attn${item.answeredAt ? ' answered' : ''}`}>
        <AttentionCard item={item} />
      </div>
    )
  }
  // 待办列表还没拉到（或已不在列表里）：先显示请求本身，处理入口在运行页
  return (
    <div className="chat-attn chat-attn-fallback">
      <UserRoundCheck aria-hidden="true" />
      <p>{m.text}</p>
      {m.refs?.runId && (
        <Link className="btn btn-sm" to={`/run/${m.refs.runId}${m.refs.nodeId ? `?node=${encodeURIComponent(m.refs.nodeId)}` : ''}`}>
          去运行页处理
        </Link>
      )}
    </div>
  )
}
