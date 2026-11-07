import { useEffect, useState, type CSSProperties } from 'react'
import type { KnowledgeBaseSummary, KnowledgeBuild } from '@taktflow/core'
import { useSource } from '../../api'
import { CountUp, StatusBadge, vtName } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { Link } from '../../lib/router'
import { kbStatusMeta, kindMeta, pct, scaleText } from './meta'

/** 类型图标块：色系只染图标底，运行中套节拍呼吸外环。 */
export function KindGlyph({ kind, size = 36, live }: { kind: string; size?: number; live?: boolean }) {
  const m = kindMeta(kind)
  const Icon = m.icon
  return (
    <span className={`kb-glyph${live ? ' live-ring' : ''}`} style={{ '--kb-c': m.color, width: size, height: size } as CSSProperties} aria-hidden>
      <Icon strokeWidth={1.75} />
    </span>
  )
}

/** 构建进度：订阅 SSE，每条都是完整的 KnowledgeBuild；没有订阅到时用摘要里的 building 兜底。 */
export function useLiveBuild(baseId: string, buildId: string | undefined, onEnd?: (b: KnowledgeBuild) => void): KnowledgeBuild | undefined {
  const ds = useSource()
  const [build, setBuild] = useState<KnowledgeBuild>()
  useEffect(() => {
    if (!buildId) return setBuild(undefined)
    let alive = true
    ds.knowledgeBuild(baseId, buildId).then((b) => alive && setBuild(b), () => undefined)
    const off = ds.subscribeKnowledgeBuild(baseId, buildId, (b) => {
      if (!alive) return
      setBuild(b)
      if (b.status !== 'running') onEnd?.(b)
    })
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, baseId, buildId])
  return build
}

/** 构建整体进度（0..1）：已完成阶段记满，运行中阶段按 done/total。 */
export function buildProgress(b: Pick<KnowledgeBuild, 'stages'>): number {
  const stages = b.stages.filter((s) => s.status !== 'skipped')
  if (!stages.length) return 0
  const sum = stages.reduce((n, s) => n + (s.status === 'done' ? 1 : s.total ? s.done / s.total : 0), 0)
  return sum / stages.length
}

function recallTone(v: number): string {
  return v >= 0.85 ? 'success' : v >= 0.75 ? 'waiting' : 'failed'
}

export function KnowledgeCard({ base, className, style, onBuildEnd }: { base: KnowledgeBaseSummary; className?: string; style?: CSSProperties; onBuildEnd?: () => void }) {
  const live = useLiveBuild(base.id, base.building?.buildId, onBuildEnd)
  const running = live ? live.status === 'running' : !!base.building
  const status = kbStatusMeta(base, running)
  const stage = live?.stages.find((s) => s.status === 'running') ?? live?.stages.find((s) => s.status === 'todo')
  const progress = live ? buildProgress(live) : base.building ? base.building.done / Math.max(1, base.building.total) : 0
  const meta = kindMeta(base.kind)
  const u = base.usage7d
  const hasUsage = u.queries > 0
  return (
    <Link to={`/knowledge/${base.id}`} data-steward-anchor={base.id} className={`kb-card hover-lift pressable${className ? ` ${className}` : ''}`} style={style}>
      <div className="kb-card-head">
        <KindGlyph kind={base.kind} live={running} />
        <div className="kb-card-title">
          <strong className="truncate" style={{ viewTransitionName: vtName('kb', base.id) }}>
            {base.name}
          </strong>
          <span className="kb-card-sub">
            {meta.label}
            <span className="kb-dot" aria-hidden />
            {base.version ? <span className="mono">v{base.version}</span> : '未发布'}
            {base.candidateVersion ? <span className="kb-cand mono">候选 v{base.candidateVersion}</span> : null}
          </span>
        </div>
        <StatusBadge meta={status} />
      </div>
      <p className="kb-card-desc">{base.description || '还没有写说明'}</p>
      <div className="kb-card-stats">
        <div className="kb-stat">
          <span className="kb-stat-v num">{hasUsage ? <CountUp value={u.queries} /> : '—'}</span>
          <span className="kb-stat-k">7 天查询</span>
        </div>
        <div className="kb-stat">
          <span className="kb-stat-v num">{hasUsage ? <CountUp value={u.hitRate} format={(v) => pct(v)} /> : '—'}</span>
          <span className="kb-stat-k">命中率</span>
        </div>
        <div className="kb-stat">
          {base.lastEval ? (
            <span className={`kb-recall num`} data-tone={recallTone(base.lastEval.recall10)}>
              <CountUp value={base.lastEval.recall10} format={(v) => v.toFixed(2)} />
            </span>
          ) : (
            <span className="kb-stat-v num">—</span>
          )}
          <span className="kb-stat-k">Recall@10</span>
        </div>
      </div>
      {running ? (
        <div className="kb-card-build" aria-live="polite">
          <div className="kb-card-build-row">
            <span>{stage?.title ?? base.building?.stage ?? '排队'}</span>
            <span className="num faint">{stage ? `${stage.done}/${stage.total}` : base.building ? `${base.building.done}/${base.building.total}` : ''}</span>
            <span className="num kb-card-build-pct">{pct(progress)}</span>
          </div>
          <span className="meter" data-tone="running" style={{ '--meter': progress } as CSSProperties}>
            <span className="meter-fill" />
          </span>
        </div>
      ) : (
        <div className="kb-card-foot">
          <span>{scaleText(base)}</span>
          {base.builtAt && <span className="faint">{fmtRelative(base.builtAt)}构建</span>}
          {!!base.staleDocs && <span className="kb-stale">{base.staleDocs} 篇过期</span>}
          {!base.bound && <span className="faint kb-unbound">未绑定本空间</span>}
        </div>
      )}
    </Link>
  )
}
