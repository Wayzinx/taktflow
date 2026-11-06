import { useState } from 'react'
import { ArrowRight, PencilLine } from 'lucide-react'
import type { RouteDecision } from '@taktflow/core'
import { fmtTime } from '../lib/format'
import { usePresence } from '../lib/motion'
import { RouteChange } from './route-card.change'
import { actorName, RouteFacts } from './route-card.facts'
import { TIER_LABEL } from './tier-glyph'
import './route-card.css'

/**
 * 路由卡：群聊里 kind 为 route 的消息。档位图标、流程、门禁、角色、理由、调整说明；
 * 改档 → 命令 route.preview（带 tier / reason），结果在卡片里预览，不直接改运行。
 */
export function RouteCard({ route, requirementId, runId }: { route: RouteDecision; requirementId: string; runId?: string }) {
  const [editing, setEditing] = useState(false)
  const panel = usePresence(editing, 140)
  const o = route.overridden
  return (
    <section className="route-card" aria-label={`路由卡：${TIER_LABEL[route.tier].title}，流程 ${route.workflowId}`} data-run={runId}>
      <RouteFacts route={route} />
      <footer className="route-foot">
        {o ? (
          <span className="route-override">
            <PencilLine aria-hidden="true" />
            {actorName(o.by)} 改档
            <span className="mono">{o.from}</span>
            <ArrowRight aria-hidden="true" />
            <span className="mono">{route.tier}</span>
            <span className="faint truncate">：{o.reason}</span>
          </span>
        ) : (
          <span className="faint">
            {actorName(route.decidedBy)} 决定 · <time dateTime={route.at}>{fmtTime(route.at).slice(0, 5)}</time>
          </span>
        )}
        <span className="spacer" />
        <button className="btn btn-sm" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          <PencilLine />
          {editing ? '收起' : '改档'}
        </button>
      </footer>
      {panel.mounted && <RouteChange state={panel.state} current={route} requirementId={requirementId} onClose={() => setEditing(false)} />}
    </section>
  )
}
