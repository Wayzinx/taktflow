import { useEffect, useRef } from 'react'
import { invalidate, useSource } from '../api'
import { diffPulse, pulseIcon, pulseSnap, pulseTitle, type PulseEvent, type PulseSnap } from '../lib/pulse'
import { navigate, useLocation } from '../lib/router'
import { toast } from './ui'

const VISIBLE_MS = 15_000
const HIDDEN_MS = 60_000

const OUTCOME = { succeeded: { text: '已完成', tone: 'success' }, failed: { text: '失败了', tone: 'failed' }, cancelled: { text: '已取消', tone: 'pending' }, ended: { text: '已结束', tone: 'success' } } as const

/** 一件事 → 卡片文案与去处；系统通知点开也去同一个地方。 */
function card(e: PulseEvent): { title: string; body: string; tone: 'success' | 'failed' | 'pending' | 'waiting'; go: string; actions: Array<{ label: string; to: string }> } {
  if (e.type === 'run-ended') {
    const o = OUTCOME[e.outcome]
    return { title: `${e.requirementId} 运行${o.text}`, body: e.title, tone: o.tone, go: `/run/${e.runId}`, actions: [{ label: '看运行', to: `/run/${e.runId}` }, { label: '回到需求', to: `/req/${e.requirementId}` }] }
  }
  return { title: `${e.requirementId} 等你决定`, body: e.ask, tone: 'waiting', go: '/attention', actions: [{ label: '去处理', to: '/attention' }] }
}

function setIcon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link && link.href !== href) link.href = href
}

/**
 * 脉搏（docs/design/25 §4）：外壳定时取一次当前空间总览，和上一次比——
 * 有变化才让页面刷新；标签页标题带等你决定的数量、图标带状态点；运行结束 / 新的等你决定弹卡片，
 * 页面在后台且开了浏览器通知时发系统通知。首次加载、切换空间后的第一次不提示。
 * 同时维护根元素的 data-tab-hidden：页面隐藏时所有无限动画暂停（styles/motion.css）。
 */
export function usePulse() {
  const ds = useSource()
  const { spaceId } = useLocation()
  const notify = useRef(false)

  useEffect(() => {
    ds.stewardPrefs()
      .then((p) => (notify.current = !!p.browserNotifications))
      .catch(() => {
        // 偏好读不到就不发系统通知，卡片照常
      })
  }, [ds])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let prev: PulseSnap | undefined
    const announce = (e: PulseEvent) => {
      const c = card(e)
      toast(c.title, { tone: c.tone, body: c.body, duration: 9000, actions: c.actions.map((a) => ({ label: a.label, onClick: () => navigate(a.to) })) })
      if (!document.hidden || !notify.current || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      const n = new Notification(c.title, { body: c.body, tag: e.type === 'run-ended' ? e.runId : e.requestId })
      n.onclick = () => {
        window.focus()
        navigate(c.go)
        n.close()
      }
    }
    const tick = async () => {
      clearTimeout(timer)
      try {
        const snap = pulseSnap(await ds.project())
        if (!alive) return
        document.title = pulseTitle(snap.waiting)
        setIcon(pulseIcon(snap.waiting ? 'waiting' : snap.running ? 'running' : 'idle'))
        if (prev && prev.sig !== snap.sig) {
          invalidate()
          diffPulse(prev, snap).slice(0, 3).forEach(announce)
        }
        prev = snap
      } catch {
        // 取不到就等下一拍，不打断页面
      }
      if (alive) timer = setTimeout(() => void tick(), document.hidden ? HIDDEN_MS : VISIBLE_MS)
    }
    const onVisibility = () => {
      document.documentElement.toggleAttribute('data-tab-hidden', document.hidden)
      // 回到页面立刻对一次，不等下一拍
      if (!document.hidden) void tick()
    }
    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ds, spaceId])
}
