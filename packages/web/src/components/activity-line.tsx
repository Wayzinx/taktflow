import { useEffect, useRef, useState } from 'react'
import type { NodeActivity } from '@taktflow/core'
import { toolAction } from '../lib/actions'
import { LONG_STEP_MS } from './agent-mark'
import './activity-line.css'

/** 每秒刷新一次的当前时间；只有挂着的组件在走。 */
export function useSecondTick(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

const sameAction = (a?: NodeActivity, b?: NodeActivity) => a?.state === b?.state && a?.tool === b?.tool && a?.input === b?.input

/**
 * 显示用的动作：每个动作至少停留 holdMs 才换下一个。agent 每秒能发几十个事件（思考片段、短工具调用），
 * 直接跟着换会让节点的动作行和蜂一直闪；停留期间来的新动作只记最新的一个，到点再换。
 */
export function useSteadyActivity(activity: NodeActivity | undefined, holdMs = 900): NodeActivity | undefined {
  const [shown, setShown] = useState(activity)
  const shownAt = useRef(Date.now())
  const latest = useRef(activity)
  latest.current = activity
  useEffect(() => {
    if (sameAction(activity, shown)) {
      if (activity?.since !== shown?.since) setShown(activity)
      return
    }
    const wait = holdMs - (Date.now() - shownAt.current)
    const swap = () => {
      shownAt.current = Date.now()
      setShown(latest.current)
    }
    // 结束（没有动作了）立刻换；否则等当前动作停够
    if (!activity || !shown || wait <= 0) return swap()
    const t = setTimeout(swap, wait)
    return () => clearTimeout(t)
  }, [activity, shown, holdMs])
  return shown
}

export function activityText(a: NodeActivity): { verb: string; target?: string; full?: string } {
  if (a.state === 'thinking') return { verb: '思考中' }
  if (a.state === 'compacting') return { verb: '压缩上下文' }
  const act = toolAction(a.tool ?? '', a.input ?? '')
  if (a.state === 'waiting_tool') return { verb: `等${act.verb}结果`, target: act.target, full: act.full }
  return { verb: act.verb, target: act.target, full: act.full }
}

const secs = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`)

/**
 * 运行中节点的动作行（docs/design/26 §1）：动词 + 对象 + 已用时间；≥ 15 秒标"长步骤"。
 * 动作换了就整行换一次（key 变化触发入场），计时由这里现场算，server 只给 since。
 */
export function ActivityLine({ activity, className }: { activity: NodeActivity; className?: string }) {
  const now = useSecondTick()
  const t = activityText(activity)
  const ms = now - Date.parse(activity.since)
  const long = ms >= LONG_STEP_MS
  return (
    <span key={`${activity.state}:${activity.tool ?? ''}:${activity.input ?? ''}`} className={`act-line${long ? ' is-long' : ''}${className ? ` ${className}` : ''}`} data-state={activity.state} title={t.full ? `${t.verb} ${t.full}` : t.verb}>
      <b className="act-verb">{t.verb}</b>
      {activity.state === 'thinking' && (
        <span className="act-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      )}
      {t.target && <span className="act-target mono truncate">{t.target}</span>}
      <span className={long ? 'act-long mono num' : 'act-time mono num'}>{long ? `长步骤 ${secs(ms)}` : secs(ms)}</span>
    </span>
  )
}
