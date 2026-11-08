import { useEffect, useState, type CSSProperties } from 'react'
import type { NodeStatus, StageProgress } from '@taktflow/core'
import { STAGE_STATUS, toneVar } from '../lib/status'
import './stage-rail.css'

const ACTIVE = new Set<StageProgress['status']>(['running', 'waiting_human', 'failed'])
const FILL_MS = 700
const MAX_TICKS = 12

/** 当前阶段一句话：在跑 / 等你 / 失败 + 当前节点标题。 */
const CUR_WORD: Partial<Record<StageProgress['status'], string>> = { running: '在跑', waiting_human: '等你', failed: '失败' }

/**
 * 阶段轨道（详情页头部、运行页头部）：一条轨道串起各阶段站点，已完成的段实色，
 * 当前阶段从站点往下一站走出"本阶段完成比例"那么长，头上一颗按节拍跳的光点；没走到的段是虚线。
 * 站点下面是阶段名 + 节点刻度（一个节点一格）+ 计数，当前阶段再加一句"在跑：xxx"。
 * 首次出现：轨道从左往右铺开，走过一站点亮一站（勾按到达时间描出来）；全部完成时一道光扫过、站点依次轻跳一下。
 * 之后状态变化只做过渡（轨道伸长、站点换色），不重播入场。onStage：站点可点（详情页 → 运行页定位，运行页 → 画布聚焦）。
 *
 * 两个时间变量：--reach 是入场时轨道铺到这一站的时刻（入场播完归零，之后完成的站立刻点亮）；
 * --lit 一直按"轨道铺到这一站"算，给当前站的点亮与外环用——当前阶段换了，轨道伸过去的同时新站才亮。
 */
export function StageRail({
  stages,
  empty = '尚未运行',
  onStage,
  activeId,
  current,
  size = 'md',
}: {
  stages: StageProgress[]
  empty?: string
  onStage?: (id: string) => void
  activeId?: string
  current?: { title: string; status?: NodeStatus }
  size?: 'md' | 'sm'
}) {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), FILL_MS + 600)
    return () => clearTimeout(t)
  }, [])
  const n = stages.length
  if (n === 0) return <span className="stage-empty">{empty}</span>
  const complete = stages.every((s) => s.status === 'done')
  const curIdx = stages.findIndex((s) => ACTIVE.has(s.status))
  // 连续完成到哪一站
  let reached = -1
  while (reached + 1 < n && stages[reached + 1]!.status === 'done') reached++
  const at = (i: number) => (n === 1 ? 0 : i / (n - 1))
  const cur = curIdx >= 0 ? stages[curIdx]! : undefined
  const pDone = complete ? 1 : at(Math.max(curIdx >= 0 ? curIdx : reached, 0)) * (curIdx >= 0 || reached >= 0 ? 1 : 0)
  // 当前阶段从站点往下一站走出完成比例那么长（至少露头、离下一站留出空隙）
  const frac = cur ? 0.1 + 0.68 * (cur.total ? Math.min(1, cur.done / cur.total) : 0) : 0
  // 当前在最后一站时没有"往下一站走"的那一段
  const live = cur && curIdx < n - 1
  const pLive = live ? at(curIdx) + frac / (n - 1) : pDone
  const tone = cur ? toneVar(STAGE_STATUS[cur.status].tone) : 'var(--st-success)'
  const style = { '--n': n, '--p-done': pDone, '--p-live': pLive, '--rail-tone': tone } as CSSProperties
  return (
    <div className="rail" data-size={size} data-complete={complete || undefined} data-live={cur ? cur.status : undefined} style={style}>
      <div className="rail-track" aria-hidden>
        <span className="rail-base" />
        <span className="rail-done">{complete && <span className="rail-sweep" />}</span>
        {live && <span className="rail-live" />}
        {live && <span className="rail-head" />}
      </div>
      <ol className="rail-stops" aria-label={`阶段进度：${stages.filter((s) => s.status === 'done').length}/${n} 完成`}>
        {stages.map((s, i) => {
          const meta = STAGE_STATUS[s.status]
          const isCur = i === curIdx
          // 轨道铺到这一站的时刻
          const lit = pDone > 0 ? Math.round(Math.min(1, at(i) / pDone) * FILL_MS) : 0
          const Tag = onStage ? 'button' : 'div'
          const label = `${s.title}，${meta.label}，${s.done}/${s.total} 个节点`
          return (
            <li key={s.id} className={`rail-stop st-${s.status}${isCur ? ' is-cur' : ''}${activeId === s.id ? ' on' : ''}`} style={{ '--i': i, '--reach': `${settled ? 0 : lit}ms`, '--lit': `${lit}ms`, '--stop-tone': toneVar(meta.tone) } as CSSProperties} aria-current={isCur ? 'step' : undefined}>
              <Tag
                {...(onStage ? { type: 'button' as const, onClick: () => onStage(s.id), 'aria-pressed': activeId === s.id } : {})}
                className={`rail-hit${onStage ? ' rail-click' : ''}`}
                title={`${label}${onStage ? (size === 'sm' ? ' · 点击在画布上定位' : ' · 点击去运行页') : ''}`}
                aria-label={label}
              >
                <span className="rail-node">
                  <StopGlyph key={s.status} status={s.status} index={i} />
                </span>
                <span className="rail-title">{s.title}</span>
                <span className="rail-meta">
                  <Ticks stage={s} />
                  <span className="rail-count num">
                    {s.done}/{s.total}
                  </span>
                </span>
                {isCur && size === 'md' && (
                  <span className={`rail-cur truncate${s.status === 'running' ? ' shimmer-text' : ''}`}>
                    {CUR_WORD[s.status]}
                    {current?.title ? `：${current.title}` : ''}
                  </span>
                )}
              </Tag>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** 站点里的图形：完成是描出来的勾，进行中是节拍点，等人是暂停双竖，失败是叉，没开始是序号。换状态时 key 变化、轻轻换入。 */
function StopGlyph({ status, index }: { status: StageProgress['status']; index: number }) {
  if (status === 'todo') return <span className="rail-idx num">{index + 1}</span>
  return (
    <svg className="rail-glyph" viewBox="0 0 16 16" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {status === 'done' && <path className="rail-check" d="M4.2 8.4l2.5 2.4 5.1-5.4" pathLength={1} />}
      {status === 'running' && <circle className="rail-dot" cx="8" cy="8" r="2.6" />}
      {status === 'waiting_human' && <path d="M6.2 5.2v5.6M9.8 5.2v5.6" />}
      {status === 'failed' && <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" />}
    </svg>
  )
}

/** 节点刻度：一个节点一格，完成的实色、当前那格按状态着色；超过 12 个节点改成一条细进度。 */
function Ticks({ stage: s }: { stage: StageProgress }) {
  if (s.total > MAX_TICKS)
    return (
      <span className="rail-mini" aria-hidden>
        <span style={{ '--p': s.total ? s.done / s.total : 0 } as CSSProperties} />
      </span>
    )
  const active = ACTIVE.has(s.status)
  return (
    <span className="rail-ticks" aria-hidden>
      {Array.from({ length: s.total }, (_, i) => (
        <span key={i} data-t={i < s.done ? 'done' : active && i === s.done ? 'cur' : undefined} />
      ))}
    </span>
  )
}
