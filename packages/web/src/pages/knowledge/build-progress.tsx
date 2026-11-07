import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { KnowledgeBuild, KnowledgeBuildStage } from '@taktflow/core'
import { Ban, CircleCheck, CircleDashed, CircleSlash, CircleX, ExternalLink, LoaderCircle } from 'lucide-react'
import { useSource } from '../../api'
import { toast } from '../../components/ui'
import { actorName, durationBetween, fmtDuration, fmtRelative } from '../../lib/format'
import { Link } from '../../lib/router'
import { buildProgress } from './card'
import { pct } from './meta'

const STAGE_ICON: Record<KnowledgeBuildStage['status'], typeof CircleCheck> = { todo: CircleDashed, running: LoaderCircle, done: CircleCheck, failed: CircleX, skipped: CircleSlash }
export const BUILD_STATUS: Record<KnowledgeBuild['status'], { label: string; tone: string }> = {
  running: { label: '构建中', tone: 'running' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'failed' },
  cancelled: { label: '已取消', tone: 'skipped' },
}

/** 分阶段进度：解析 n/N → 切块 → 嵌入 → 索引；每段一根 scaleX 进度条。 */
export function StageList({ build }: { build: KnowledgeBuild }) {
  return (
    <ol className="kb-stages">
      {build.stages.map((s) => {
        const Icon = STAGE_ICON[s.status]
        const v = s.status === 'done' ? 1 : s.total ? s.done / s.total : 0
        return (
          <li key={s.id} className="kb-stage" data-status={s.status}>
            <Icon className={s.status === 'running' ? 'spin' : undefined} aria-hidden />
            <span className="kb-stage-title">{s.title}</span>
            <span className="meter" data-tone={s.status === 'failed' ? 'danger' : s.status === 'done' ? 'success' : 'running'} style={{ '--meter': v } as CSSProperties}>
              <span className="meter-fill" />
            </span>
            <span className="num faint kb-stage-n">{s.status === 'skipped' ? '跳过' : `${s.done.toLocaleString()}/${s.total.toLocaleString()}`}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** 日志：最近 200 行，运行中末尾光标闪烁，新行到来时滚到底（用户往上翻时不打扰）。 */
export function BuildLog({ lines, live }: { lines: string[]; live?: boolean }) {
  const box = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines.length])
  return (
    <pre ref={box} className="kb-log mono" onScroll={(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)} aria-label="构建日志">
      {lines.map((l, i) => (
        <span key={i} className={live && i === lines.length - 1 ? 'stream-caret' : undefined}>
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}

/** 一次构建的完整视图：总进度、阶段、日志、出错的文档、取消。向导第 4 步与详情页"构建"Tab 共用。 */
export function BuildProgress({ build, onCancelled, showLog = true }: { build: KnowledgeBuild; onCancelled?: (b: KnowledgeBuild) => void; showLog?: boolean }) {
  const ds = useSource()
  const [busy, setBusy] = useState(false)
  const running = build.status === 'running'
  const p = buildProgress(build)
  async function cancel() {
    setBusy(true)
    try {
      const b = await ds.cancelKnowledgeBuild(build.baseId, build.id)
      toast(`已取消构建 v${b.version}`, { tone: 'pending', body: '已发布的版本不受影响。' })
      onCancelled?.(b)
    } catch (e) {
      toast('取消失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="kb-build" data-status={build.status}>
      <div className="kb-build-head">
        <span className={`kb-build-badge${running ? ' live-ring' : ''}`} data-tone={BUILD_STATUS[build.status].tone}>
          {BUILD_STATUS[build.status].label}
        </span>
        <strong className="num">v{build.version}</strong>
        <span className="faint">
          {actorName(build.by)} · {fmtRelative(build.startedAt)}开始{build.endedAt ? ` · 用时 ${fmtDuration(durationBetween(build.startedAt, build.endedAt) ?? 0)}` : ''}
        </span>
        <span className="kb-spacer" />
        {build.runId && (
          <Link to={`/run/${build.runId}`} className="btn btn-sm btn-ghost">
            <ExternalLink />
            查看生成运行
          </Link>
        )}
        {running && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void cancel()}>
            <Ban />
            取消构建
          </button>
        )}
      </div>
      {running && (
        <div className="kb-build-total">
          <span className="meter meter-lg" data-tone="running" style={{ '--meter': p } as CSSProperties}>
            <span className="meter-fill" />
          </span>
          <span className="num">{pct(p)}</span>
        </div>
      )}
      <StageList build={build} />
      {!!build.errors?.length && (
        <div className="kb-build-errors" role="alert">
          <div className="section-label">出错的文档</div>
          <ul>
            {build.errors.map((e) => (
              <li key={e.ref}>
                <span className="mono">{e.ref}</span>
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showLog && <BuildLog lines={build.log} live={running} />}
    </div>
  )
}
