import { useState } from 'react'
import type { KnowledgeBaseDetail, KnowledgeBuild } from '@taktflow/core'
import { ChevronDown, Hammer } from 'lucide-react'
import { EmptyState, useFlashRows, useStagger } from '../../components/ui'
import { actorName, durationBetween, fmtDuration, fmtRelative } from '../../lib/format'
import { BUILD_STATUS, BuildProgress } from './build-progress'

/** 构建：历史列表，运行中的一条展开并实时更新；失败的显示出错文档与日志。 */
export function BuildsTab({ base, live, reload, onBuild }: { base: KnowledgeBaseDetail; live?: KnowledgeBuild; reload: () => void; onBuild: () => void }) {
  // live 来自页头订阅：同一条构建用实时版本替换
  const builds = base.builds.map((b) => (live && b.id === live.id ? live : b))
  if (live && !builds.some((b) => b.id === live.id)) builds.unshift(live)
  const [open, setOpen] = useState<string | undefined>(() => builds.find((b) => b.status === 'running' || b.status === 'failed')?.id)
  const st = useStagger(builds.length)
  const flash = useFlashRows(builds.map((b) => b.id))

  if (!builds.length)
    return (
      <EmptyState
        icon={Hammer}
        title="还没有构建过"
        body="构建会解析数据源、切块、嵌入并建索引，产出一个候选版本。"
        action={
          <button type="button" className="btn btn-primary" onClick={onBuild}>
            开始构建
          </button>
        }
        stewardAsk={`帮我检查知识库「${base.name}」的数据源配置，然后构建一次`}
      />
    )
  return (
    <ul className="kb-builds">
      {builds.map((b, i) => {
        const s = st(i)
        const isOpen = open === b.id || b.status === 'running'
        const meta = BUILD_STATUS[b.status]
        return (
          <li key={b.id} className={`kb-build-item ${s.className ?? ''} ${flash(b.id)}`} style={s.style} data-open={isOpen}>
            <button type="button" className="kb-build-row pressable" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? undefined : b.id)}>
              <span className={`kb-build-badge${b.status === 'running' ? ' live-ring' : ''}`} data-tone={meta.tone}>
                {meta.label}
              </span>
              <strong className="num">v{b.version}</strong>
              <span className="faint">{actorName(b.by)}</span>
              <span className="faint">{fmtRelative(b.startedAt)}</span>
              <span className="faint num">{b.endedAt ? fmtDuration(durationBetween(b.startedAt, b.endedAt) ?? 0) : ''}</span>
              <span className="kb-spacer" />
              {b.errors?.length ? <span className="kb-tag" data-tone="failed">{b.errors.length} 个文档出错</span> : null}
              {b.stats && <span className="faint num">{b.stats.chunks.toLocaleString()} 块</span>}
              <ChevronDown className={`kb-chev${isOpen ? ' open' : ''}`} aria-hidden />
            </button>
            <div className="expand" data-open={isOpen}>
              <div inert={!isOpen}>
                <div className="kb-build-detail">
                  <BuildProgress build={b} onCancelled={reload} />
                </div>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
