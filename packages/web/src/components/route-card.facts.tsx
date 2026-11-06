import { FolderTree, Info, ShieldCheck, Users } from 'lucide-react'
import type { Actor, RouteDecision } from '@taktflow/core'
import { TIER_LABEL, TierGlyph } from './tier-glyph'

export function actorName(a: Actor): string {
  if (a.type === 'human') return a.id === 'web' ? '你' : a.id
  if (a.type === 'agent') return a.role === 'lead' ? 'Lead' : a.role
  return a.id === 'engine' ? '路由器' : a.id
}

/** 路由卡的主体（预览结果复用）：档位、流程、门禁、角色、改动面、调整说明。 */
export function RouteFacts({ route, compact }: { route: RouteDecision; compact?: boolean }) {
  return (
    <>
      <div className="route-head">
        <span className="route-tier" data-tier={route.tier}>
          <TierGlyph tier={route.tier} size={compact ? 18 : 22} label={false} />
        </span>
        <span className="route-title">
          <span className="route-tier-title">{TIER_LABEL[route.tier].title}</span>
          <span className="route-tier-hint">{TIER_LABEL[route.tier].hint}</span>
        </span>
        <span className="route-flow">
          <span className="route-k">流程</span>
          <span className="mono">{route.workflowId}</span>
        </span>
      </div>
      {!compact && <p className="route-reason">{route.reason}</p>}
      <dl className="route-facts">
        <div>
          <dt>
            <ShieldCheck aria-hidden="true" />
            门禁
          </dt>
          <dd>{route.gates.length ? route.gates.map((g) => <span key={g} className="chip route-chip">{g}</span>) : <span className="faint">无</span>}</dd>
        </div>
        <div>
          <dt>
            <Users aria-hidden="true" />
            角色
          </dt>
          <dd>{route.roles.length ? route.roles.map((r) => <span key={r} className="chip route-chip mono">{r}</span>) : <span className="faint">无</span>}</dd>
        </div>
        {!compact && route.surfaces.length > 0 && (
          <div>
            <dt>
              <FolderTree aria-hidden="true" />
              改动面
            </dt>
            <dd className="route-surfaces">
              {route.surfaces.map((s) => (
                <span key={s.id} className="route-surface" title={s.paths.join('\n')}>
                  <span className="mono route-surface-id">{s.id}</span>
                  {s.repo && <span className="mono faint">{s.repo}</span>}
                  <span className="mono faint truncate">{s.paths.join('  ')}</span>
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {route.adjustments?.length ? (
        <ul className="route-adjust" aria-label="确定性校验做过的调整">
          {route.adjustments.map((a) => (
            <li key={a}>
              <Info aria-hidden="true" />
              <span>{a}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

