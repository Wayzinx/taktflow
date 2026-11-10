import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, PanelRightOpen } from 'lucide-react'
import type { StewardEntitySnapshot, StewardTone } from '@taktflow/core'
import { useSource } from '../../../api'
import { sameFocus, useEntityFocus, type FocusTarget } from '../../../components/steward/focus'
import { LaneTrack } from '../../../components/viz'
import { refPath } from '../../../components/viz/ref'
import { fmtRelative } from '../../../lib/format'
import { Link } from '../../../lib/router'
import { onTabReturn } from '../../../lib/visible'

/** 刷新计数：bump 一次，依赖它的查询就重拉一次。 */
export function useTick(): [number, () => void] {
  const [tick, setTick] = useState(0)
  return [tick, useCallback(() => setTick((t) => t + 1), [])]
}

/** 查询换 key 时 data 会先变成 undefined：保留上一份，避免实时刷新时闪成骨架。 */
export function useKept<T>(v: T | undefined): T | undefined {
  const [kept, setKept] = useState(v)
  if (v !== undefined && v !== kept) setKept(v)
  return v ?? kept
}

/** 运行在跑时订阅它的事件流，每批事件（400ms 节流）调用一次 onBatch。 */
export function useRunEvents(runId: string | undefined, live: boolean, onBatch: () => void) {
  const ds = useSource()
  const cb = useRef(onBatch)
  cb.current = onBatch
  useEffect(() => {
    if (!runId || !live) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = ds.subscribe(runId, () => {
      timer ??= setTimeout(() => {
        timer = undefined
        cb.current()
      }, 400)
    })
    const offReturn = onTabReturn(() => cb.current())
    return () => {
      off()
      offReturn()
      if (timer) clearTimeout(timer)
    }
  }, [ds, runId, live])
}

/** 在视口里（上下各放宽 300px）时为 true：重视图只在看得见时挂载，滚远了卸下。 */
export function useInView<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  // 回调 ref：元素常常在数据到了之后才挂上（先渲染骨架），要等它出现再观察
  const [el, setEl] = useState<T | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (!el) return
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { rootMargin: '300px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [el])
  return [setEl, inView]
}

const TONE_WORD: Record<StewardTone, string> = { neutral: '', success: '完成', running: '进行中', waiting: '等你', failed: '失败', stale: '过期' }

export function TonePill({ tone, children }: { tone: StewardTone; children?: ReactNode }) {
  return (
    <span className="ent-pill" data-tone={tone}>
      {children ?? TONE_WORD[tone]}
    </span>
  )
}

/** 卡片底部：实时点 + 更新时间 + 展开。焦点面板里（或已是焦点）不显示展开；停靠面板里没有焦点面板，改为跳页。 */
export function EntityFoot({ target, live, at, inPanel, children }: { target: FocusTarget; live?: boolean; at?: string; inPanel?: boolean; children?: ReactNode }) {
  const focus = useEntityFocus()
  const path = refPath(target.node ? { type: 'node', spaceId: target.ref.spaceId, id: target.node, parent: target.ref.id } : target.ref)
  return (
    <div className="ent-foot">
      <span className="ent-live" data-live={live || undefined}>
        {live ? '实时' : '已同步'}
      </span>
      {at && <span className="faint">{fmtRelative(at)}更新</span>}
      {children}
      <span className="ent-foot-gap" />
      {!inPanel && focus ? (
        sameFocus(focus.current, target) ? (
          <span className="ent-shown">
            <PanelRightOpen />
            已在右侧
          </span>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm ent-expand" onClick={() => focus.open(target)}>
            <PanelRightOpen />
            在右侧展开
          </button>
        )
      ) : (
        path && (
          <Link to={path} className="btn btn-ghost btn-sm ent-expand">
            <ArrowUpRight />
            打开完整页面
          </Link>
        )
      )}
    </div>
  )
}

/** 取不到实时数据（没权限、已删除、服务不可达）时：显示出块那一刻的快照，并写明原因。 */
export function SnapshotCard({ snapshot, reason }: { snapshot: StewardEntitySnapshot; reason?: string }) {
  return (
    <div className="ent ent-snap">
      <div className="ent-head">
        <b className="ent-title truncate">{snapshot.title}</b>
        <span className="ent-gap" />
        <TonePill tone={snapshot.tone}>{snapshot.status}</TonePill>
      </div>
      {snapshot.stages && snapshot.stages.length > 0 && <LaneTrack cells={snapshot.stages.map((s, i) => ({ key: `${i}`, label: s.label, status: s.status }))} animate={false} />}
      {snapshot.summary && <p className="ent-note">{snapshot.summary}</p>}
      <div className="ent-foot">
        <span className="faint">
          {fmtRelative(snapshot.at)}的样子{reason ? ` · ${reason}` : ''}
        </span>
      </div>
    </div>
  )
}
