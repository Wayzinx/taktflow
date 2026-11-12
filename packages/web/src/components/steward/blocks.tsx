import { lazy, Suspense, type CSSProperties } from 'react'
import { ArrowUpRight, CircleAlert, CircleCheck, Info, MessageCircleQuestion, SquareTerminal, TriangleAlert } from 'lucide-react'
import type { StewardAction, StewardBlock, StewardContextRef, StewardTone } from '@taktflow/core'
import { openCommand } from '../command-palette'
import { Bars, Checklist, LaneTrack, StatTiles, Timeline, currentCell, LANE_LABEL, refPath } from '../viz'
import { Skeleton } from '../ui'
import { fmtRelative } from '../../lib/format'
import { navigate } from '../../lib/router'
import type { Tone } from '../../lib/status'
import './blocks.css'

// 实体视图要用运行图等重组件：按需加载，没出现实体块的会话不下载
const EntityBlockView = lazy(() => import('../../pages/solo/entity').then((m) => ({ default: m.EntityBlockView })))
const PickBlockView = lazy(() => import('../../pages/solo/entity').then((m) => ({ default: m.PickBlockView })))
const entityFallback = <Skeleton h={120} r={12} />

type Ask = (text: string, ctx?: StewardContextRef[]) => void
const toneOf = (t?: StewardTone): Tone | undefined => (t && t !== 'neutral' ? t : undefined)
const open = (ref?: StewardContextRef) => {
  const path = ref && refPath(ref)
  return path ? () => navigate(path) : undefined
}
/** ISO 时间显示成"3 小时前"，其它原样。 */
const when = (at: string) => (/^\d{4}-\d{2}-\d{2}T/.test(at) ? fmtRelative(at) : at)

function Lanes({ block }: { block: Extract<StewardBlock, { type: 'lanes' }> }) {
  return (
    <ul className="vb-lanes">
      {block.rows.map((r, i) => {
        const cells = r.stages.map((s, j) => ({ key: `${j}`, label: s.label, status: s.status }))
        const cur = currentCell(cells)
        const go = open(r.ref)
        const Row = go ? 'button' : 'div'
        return (
          <li key={i}>
            <Row {...(go ? { type: 'button' as const, onClick: go } : {})} className={`vb-lane${go ? ' vb-click' : ''}`}>
              <span className="vb-lane-head">
                <span className="vb-lane-title truncate">{r.title}</span>
                <span className="vb-lane-cur" data-tone={r.tone ?? cur?.status}>
                  {r.note ?? (cur ? `${cur.label} · ${LANE_LABEL[cur.status]}` : '已完成')}
                </span>
              </span>
              {cells.length > 0 && <LaneTrack cells={cells} size="sm" />}
            </Row>
          </li>
        )
      })}
    </ul>
  )
}

function Table({ block }: { block: Extract<StewardBlock, { type: 'table' }> }) {
  return (
    <div className="vb-table-wrap">
      <table className="vb-table">
        <thead>
          <tr>
            {block.columns.map((c) => (
              <th key={c.key} data-align={c.align}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => {
            const go = open(block.refs?.[i] ?? undefined)
            return (
              <tr key={i} className={go ? 'vb-click' : undefined} onClick={go} tabIndex={go ? 0 : undefined} onKeyDown={go ? (e) => e.key === 'Enter' && go() : undefined}>
                {block.columns.map((c) => (
                  <td key={c.key} data-align={c.align} className={c.mono ? 'mono' : undefined}>
                    {row[c.key] ?? <span className="faint">—</span>}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const CALLOUT_ICON = { success: CircleCheck, failed: CircleAlert, waiting: TriangleAlert, stale: TriangleAlert, running: Info, neutral: Info }

function Actions({ items, onAsk }: { items: StewardAction[]; onAsk?: Ask }) {
  return (
    <div className="vb-actions">
      {items.map((a, i) => {
        const run = a.kind === 'ask' ? () => onAsk?.(a.text) : a.kind === 'open' ? open(a.ref) : () => openCommand(a.commandId, a.input)
        const Icon = a.kind === 'ask' ? MessageCircleQuestion : a.kind === 'open' ? ArrowUpRight : SquareTerminal
        return (
          <button key={i} type="button" className={`btn btn-sm${a.primary ? ' btn-primary' : ''}`} onClick={run} disabled={!run} title={a.kind === 'command' ? '打开命令表单，确认后才执行' : undefined}>
            <Icon />
            {a.label}
          </button>
        )
      })}
    </div>
  )
}

function Body({ block, onAsk }: { block: StewardBlock; onAsk?: Ask }) {
  switch (block.type) {
    case 'stats':
      return <StatTiles className="tiles-sm" label={block.title ?? '读数'} tiles={block.items.map((t, i) => ({ key: `${i}`, label: t.label, value: t.value, unit: t.unit, tone: toneOf(t.tone), hint: t.hint, onClick: open(t.ref) }))} />
    case 'lanes':
      return <Lanes block={block} />
    case 'bars':
      return <Bars items={block.items.map((b, i) => ({ key: `${i}`, label: b.label, value: b.value, max: b.max, tone: toneOf(b.tone), hint: b.hint, display: `${b.value.toLocaleString()}${block.unit ?? ''}`, onClick: open(b.ref) }))} />
    case 'table':
      return <Table block={block} />
    case 'checklist':
      return <Checklist items={block.items.map((c, i) => ({ key: `${i}`, label: c.label, done: c.done, hint: c.hint, onClick: open(c.ref) }))} />
    case 'timeline':
      return <Timeline items={block.items.map((t, i) => ({ key: `${i}`, at: when(t.at), title: t.title, detail: t.detail, tone: toneOf(t.tone), onClick: open(t.ref) }))} />
    case 'callout': {
      const Icon = CALLOUT_ICON[block.tone] ?? Info
      return (
        <div className="vb-callout" data-tone={block.tone}>
          <Icon aria-hidden />
          <div>
            <div className="vb-callout-title">{block.title}</div>
            {block.body && <p className="vb-callout-body">{block.body}</p>}
          </div>
        </div>
      )
    }
    case 'actions':
      return <Actions items={block.items} onAsk={onAsk} />
    case 'entity':
      return (
        <Suspense fallback={entityFallback}>
          <EntityBlockView block={block} />
        </Suspense>
      )
    case 'pick':
      return (
        <Suspense fallback={entityFallback}>
          <PickBlockView block={block} onPick={onAsk} />
        </Suspense>
      )
    default:
      return null
  }
}

/**
 * 管家回答里的可视化块（docs/design/24）：正文之后逐块"组装"入场（间隔 60ms）。
 * 按钮只追问 / 跳转 / 打开预填命令表单，不直接执行写操作。
 */
export function StewardBlocks({ blocks, onAsk }: { blocks: StewardBlock[]; onAsk?: Ask }) {
  return (
    <div className="vb-stack">
      {blocks.map((b, i) => {
        const title = 'title' in b ? b.title : undefined
        const bare = b.type === 'actions' || b.type === 'callout' || b.type === 'stats' || b.type === 'entity' || b.type === 'pick'
        return (
          <section key={i} className={`vb${bare ? ' vb-bare' : ''}`} data-type={b.type} style={{ '--i': i } as CSSProperties} aria-label={title}>
            {/* pick 的标题就是问句，PickBlockView 自己排版，这里不再重复一行 */}
            {title && b.type !== 'pick' && <div className="vb-title">{title}</div>}
            <Body block={b} onAsk={onAsk} />
          </section>
        )
      })}
    </div>
  )
}
