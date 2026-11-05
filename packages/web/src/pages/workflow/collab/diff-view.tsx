import { HighlightLine } from './code-view'
import { diffStats, type DiffRow } from './line-diff'

/** 统一 diff 视图：双列行号 + 符号 + 高亮正文；未改动的大段折叠。 */
export function DiffView({ rows, empty = '没有改动', label }: { rows: DiffRow[]; empty?: string; label?: string }) {
  if (!rows.some((r) => r.t === '+' || r.t === '-')) return <div className="wfc-diff-empty">{empty}</div>
  return (
    <div className="wfc-diff" role="region" aria-label={label ?? '差异'} tabIndex={0}>
      {rows.map((r, i) => {
        if (r.t === 'gap') return <div key={i} className="wfc-diff-gap">⋯ {r.count} 行未改动</div>
        if (r.t === '@') return <div key={i} className="wfc-diff-hunk mono">{r.text}</div>
        return (
          <div key={i} className={`wfc-diff-line is-${r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx'}`}>
            <span className="wfc-ln" aria-hidden>{r.a ?? ''}</span>
            <span className="wfc-ln" aria-hidden>{r.b ?? ''}</span>
            <span className="wfc-sign" aria-label={r.t === '+' ? '新增' : r.t === '-' ? '删除' : undefined}>{r.t === ' ' ? '' : r.t === '+' ? '+' : '−'}</span>
            <span className="wfc-src">
              <HighlightLine text={r.text} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function DiffStat({ rows }: { rows: DiffRow[] }) {
  const s = diffStats(rows)
  return (
    <span className="wfc-diffstat mono" aria-label={`新增 ${s.added} 行，删除 ${s.removed} 行`}>
      <span className="is-add">+{s.added}</span>
      <span className="is-del">−{s.removed}</span>
    </span>
  )
}
