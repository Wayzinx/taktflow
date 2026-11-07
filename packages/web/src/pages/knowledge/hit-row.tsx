import { useState, type CSSProperties } from 'react'
import type { KnowledgeQueryResponse } from '@taktflow/core'
import { ChevronDown, ThumbsDown, ThumbsUp } from 'lucide-react'
import { fmtScore } from './meta'

export type Mark = 'rel' | 'irr' | undefined
type Hit = KnowledgeQueryResponse['hits'][number]

const EVIDENCE: Record<string, { label: string; tone: string }> = {
  verified: { label: '已核实', tone: 'success' },
  derived: { label: '推导', tone: 'running' },
  stale: { label: '可能过期', tone: 'stale' },
  conflict: { label: '有冲突', tone: 'failed' },
}

/** 分项得分条：BM25 / 向量 / rerank 各一根，scaleX 驱动。 */
export function ScoreBars({ scores }: { scores?: Hit['scores'] }) {
  const items = [
    { k: 'BM25', v: scores?.bm25, c: 'var(--c-1)' },
    { k: '向量', v: scores?.vector, c: 'var(--c-3)' },
    { k: 'rerank', v: scores?.rerank, c: 'var(--c-6)' },
  ].filter((x) => x.v !== undefined)
  if (!items.length) return null
  return (
    <div className="kb-scores" aria-label="分项得分">
      {items.map((x) => (
        <span key={x.k} className="kb-score">
          <span className="kb-score-k">{x.k}</span>
          <span className="meter" style={{ '--meter': x.v, '--meter-color': x.c } as CSSProperties}>
            <span className="meter-fill" />
          </span>
          <span className="num kb-score-v">{fmtScore(x.v)}</span>
        </span>
      ))}
    </div>
  )
}

export function HitRow({ hit, index, mark, onMark }: { hit: Hit; index: number; mark: Mark; onMark: (m: Mark) => void }) {
  const [open, setOpen] = useState(false)
  const ev = hit.evidenceLevel ? EVIDENCE[hit.evidenceLevel] : undefined
  const style = index < 10 ? ({ '--stagger-delay': `${index * 24}ms` } as CSSProperties) : undefined
  return (
    <li className={`kb-hit${index < 10 ? ' stagger-item' : ''}`} style={style} data-mark={mark}>
      <span className="kb-hit-rank num">{hit.rank ?? index + 1}</span>
      <div className="kb-hit-main">
        <div className="kb-hit-head">
          <strong className="truncate">{hit.title}</strong>
          {ev && (
            <span className="kb-tag" data-tone={ev.tone}>
              {ev.label}
            </span>
          )}
          <span className="kb-spacer" />
          <span className="kb-hit-score num" title="合并后的总分">
            {fmtScore(hit.score)}
          </span>
        </div>
        <span className="mono faint kb-hit-ref truncate">{hit.ref}</span>
        <p className="kb-hit-snippet">{hit.snippet}</p>
        <ScoreBars scores={hit.scores} />
        <div className="expand" data-open={open}>
          <div inert={!open}>
            <pre className="kb-hit-content">{hit.content ?? hit.snippet}</pre>
          </div>
        </div>
        <div className="kb-hit-actions">
          {hit.content && (
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <ChevronDown className={`kb-chev${open ? ' open' : ''}`} />
              {open ? '收起原文' : '展开原文'}
            </button>
          )}
          <span className="kb-spacer" />
          <button type="button" className={`btn btn-sm kb-mark${mark === 'rel' ? ' on' : ''}`} data-kind="rel" aria-pressed={mark === 'rel'} onClick={() => onMark('rel')}>
            <ThumbsUp />
            相关
          </button>
          <button type="button" className={`btn btn-sm kb-mark${mark === 'irr' ? ' on' : ''}`} data-kind="irr" aria-pressed={mark === 'irr'} onClick={() => onMark('irr')}>
            <ThumbsDown />
            不相关
          </button>
        </div>
      </div>
    </li>
  )
}
