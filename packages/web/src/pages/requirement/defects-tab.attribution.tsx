import { Check, CircleSlash, X } from 'lucide-react'
import type { DefectAttribution, GraphNode, RequirementDetail } from '@taktflow/core'
import { Link } from '../../lib/router'
import { MISS, ORIGIN, SUGGESTION } from '../eval/labels'

export interface NodeIndex {
  /** 节点 id → 运行图里的节点（按前缀回退到 planner / loop）。 */
  find(id: string): GraphNode | undefined
  order(id: string): number
}

export function nodeIndex(nodes: GraphNode[] = []): NodeIndex {
  const find = (id: string) => nodes.find((n) => n.id === id) ?? nodes.find((n) => id.startsWith(`${n.id}/`))
  return {
    find,
    order: (id) => {
      const n = find(id)
      return n ? nodes.indexOf(n) + (n.id === id ? 0 : 0.5) : 999
    },
  }
}

type Mark = { kind: 'introduced' } | { kind: 'missed'; reason: string } | { kind: 'passed' }

function marksOf(a: DefectAttribution): Map<string, Mark[]> {
  const m = new Map<string, Mark[]>()
  const add = (id: string | undefined, x: Mark) => id && m.set(id, [...(m.get(id) ?? []), x])
  add(a.introducedAt.nodeId, { kind: 'introduced' })
  for (const x of a.missedBy) add(x.nodeId, { kind: 'missed', reason: MISS[x.reason] })
  for (const id of [...(a.precheck.codeNodes ?? []), ...(a.precheck.reviewedBy ?? []), ...(a.precheck.gates ?? [])]) if (!m.has(id)) add(id, { kind: 'passed' })
  return m
}

function Marker({ mark }: { mark: Mark }) {
  if (mark.kind === 'introduced')
    return (
      <span className="df-mark df-mark-in" title="在这里引入">
        <i aria-hidden />
        引入
      </span>
    )
  if (mark.kind === 'missed')
    return (
      <span className="df-mark df-mark-miss" title={`本该拦住：${mark.reason}`}>
        <i aria-hidden />
        漏检 · {mark.reason}
      </span>
    )
  return null
}

/** 阶段条：引入（实心）与漏检（空心 + 原因）落在哪个阶段。 */
export function StageMarks({ a, stages, idx }: { a: DefectAttribution; stages: RequirementDetail['stages']; idx: NodeIndex }) {
  const stageOf = (id?: string, fallback?: string) => (id && idx.find(id)?.stage) || fallback
  const byStage = new Map<string, Mark[]>()
  const push = (s: string | undefined, m: Mark) => s && byStage.set(s, [...(byStage.get(s) ?? []), m])
  push(stageOf(a.introducedAt.nodeId, ORIGIN[a.introducedAt.origin].stage), { kind: 'introduced' })
  for (const x of a.missedBy) push(stageOf(x.nodeId), { kind: 'missed', reason: MISS[x.reason] })
  return (
    <ol className="df-stages" aria-label="阶段条上的归因标记">
      {stages.map((s) => {
        const ms = byStage.get(s.id) ?? []
        return (
          <li key={s.id} className={`df-stage${ms.length ? ' hit' : ''}`}>
            <span className="df-stage-rail" aria-hidden>
              {ms.map((m, i) => (
                <i key={i} className={m.kind === 'introduced' ? 'df-dot-in' : 'df-dot-miss'} />
              ))}
            </span>
            <span className="df-stage-title">{s.title}</span>
            <span className="df-stage-marks">
              {ms.map((m, i) => (
                <Marker key={i} mark={m} />
              ))}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** 简化追溯链：涉及的节点按运行图顺序串起来，标出引入 / 漏检 / 经过。 */
export function TraceChain({ a, idx, runId }: { a: DefectAttribution; idx: NodeIndex; runId?: string }) {
  const marks = marksOf(a)
  const ids = [...marks.keys()].sort((x, y) => idx.order(x) - idx.order(y))
  return (
    <ol className="df-chain" aria-label="简化追溯链">
      {ids.map((id) => {
        const ms = marks.get(id)!
        const n = idx.find(id)
        const intro = ms.some((m) => m.kind === 'introduced')
        const miss = ms.some((m) => m.kind === 'missed')
        const evidence = [...(a.introducedAt.nodeId === id ? a.introducedAt.evidence : []), ...a.missedBy.filter((x) => x.nodeId === id).flatMap((x) => x.evidence)]
        const rid = a.missedBy.find((x) => x.nodeId === id)?.runId ?? (a.introducedAt.nodeId === id ? a.introducedAt.runId : undefined) ?? runId
        return (
          <li key={id} className={`df-link${intro ? ' in' : ''}${miss ? ' miss' : ''}`}>
            <span className="df-link-node" aria-hidden />
            <div className="df-link-body">
              <div className="df-link-head">
                {rid ? (
                  <Link to={`/run/${rid}?node=${encodeURIComponent(id)}`} className="df-link-title">
                    {n && n.id === id ? n.title : id}
                  </Link>
                ) : (
                  <span className="df-link-title">{id}</span>
                )}
                <span className="mono faint truncate">{id}</span>
              </div>
              <div className="df-link-marks">
                {ms.map((m, i) => (m.kind === 'passed' ? <span key={i} className="faint df-mark-pass">经过</span> : <Marker key={i} mark={m} />))}
              </div>
              {evidence.length > 0 && (
                <ul className="df-evidence">
                  {evidence.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Yes({ v }: { v?: boolean }) {
  if (v === undefined) return <span className="faint">未知</span>
  return v ? (
    <span className="ev-pass df-yn">
      <Check aria-hidden />有
    </span>
  ) : (
    <span className="ev-fail df-yn">
      <X aria-hidden />没有
    </span>
  )
}

const ids = (l?: string[]) => (l?.length ? l.map((x) => <span key={x} className="chip mono">{x}</span>) : <span className="faint">—</span>)

export function Precheck({ p }: { p: DefectAttribution['precheck'] }) {
  return (
    <dl className="facts df-precheck">
      <dt>关联 AC 有用例</dt>
      <dd>
        <Yes v={p.acCovered} />
      </dd>
      <dt>相关用例</dt>
      <dd className="df-ids">{ids(p.cases)}</dd>
      <dt>改动代码的节点</dt>
      <dd className="df-ids">{ids(p.codeNodes)}</dd>
      <dt>经过的评审</dt>
      <dd className="df-ids">{ids(p.reviewedBy)}</dd>
      <dt>经过的门禁</dt>
      <dd className="df-ids">{ids(p.gates)}</dd>
    </dl>
  )
}

export function Suggestions({ list }: { list: DefectAttribution['suggestions'] }) {
  if (list.length === 0)
    return (
      <p className="faint df-none">
        <CircleSlash aria-hidden /> 没有改进建议
      </p>
    )
  return (
    <ol className="df-sugs">
      {list.map((s, i) => (
        <li key={i}>
          <span className="df-sug-kind">{SUGGESTION[s.target.kind]}</span>
          <span className="mono df-sug-ref">{s.target.ref}</span>
          <span className="df-sug-change">{s.change}</span>
        </li>
      ))}
    </ol>
  )
}
