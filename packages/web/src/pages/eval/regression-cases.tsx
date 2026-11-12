import type { DefectDetail } from '@taktflow/core'
import { ArrowUpRight, FlaskConical } from 'lucide-react'
import { useAsync } from '../../api'
import { SkeletonRows } from '../../components/ui'
import { Link } from '../../lib/router'
import { targetKey } from './labels'

export function RegressionCases({ d, runIds }: { d: DefectDetail; runIds: string[] }) {
  const q = useAsync((ds) => ds.evalCases(), [d.id, d.status])
  const list = (q.data ?? []).filter((c) => c.source.kind === 'defect' && c.source.defectId === d.id && (!c.source.runId || runIds.includes(c.source.runId)))
  if (!q.data) return <SkeletonRows rows={2} gap={10} />
  if (list.length === 0) return <p className="faint df-none">还没有生成回归用例。</p>
  // 本期只回放只读检查点样本：旧整节点用例、已退役样本进了新建评测也勾不上，不给「用它评测」
  const legacy = list.filter((c) => !c.sample).length
  const checkpoints = d.attribution?.checkpoints?.length ?? 0
  return (
    <>
      <ul className="df-cases">
        {list.map((c) => (
          <li key={c.id}>
            <FlaskConical aria-hidden />
            <span className="truncate">{c.title}</span>
            <span className="mono faint">{targetKey(c.target)}</span>
            {c.sample && !c.sample.retiredAt ? (
              <Link to={`/eval?tab=runs&new=${encodeURIComponent(targetKey(c.target))}`} className="btn btn-ghost btn-sm">
                用它评测
                <ArrowUpRight />
              </Link>
            ) : (
              <span className="df-tag" title={c.sample ? '样本已退役，不再回放' : '旧整节点用例：本期只回放只读检查点样本'}>
                {c.sample ? '已退役' : '旧用例 · 本期不回放'}
              </span>
            )}
          </li>
        ))}
      </ul>
      {legacy > 0 && (
        <p className="faint df-note">
          {checkpoints > 0 ? (
            <>
              要回放评测，在
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => document.querySelector('.df-miss')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                逐检查点漏检
              </button>
              里对人确认「本该拦住」的检查点生成必拦样本。
            </>
          ) : (
            '要回放评测，需要先有逐检查点漏检结论，再对「本该拦住」的检查点生成必拦样本。'
          )}
        </p>
      )}
    </>
  )
}
