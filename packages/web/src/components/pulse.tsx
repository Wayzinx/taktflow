import { useEffect, useRef } from 'react'
import { invalidate, useSource } from '../api'
import { diffPulse, pulseIcon, pulseSnap, pulseTitle, type PulseEvent, type PulseSnap } from '../lib/pulse'
import { summaryLine } from '../lib/format'
import { navigate, useLocation } from '../lib/router'
import { isNetworkError, onReconnect, reportConnection } from '../lib/connection'
import { toast } from './ui'

const VISIBLE_MS = 15_000
const HIDDEN_MS = 60_000
/** 断开时更勤地对一次，服务一回来就恢复（不等用户点重试）。 */
const OFFLINE_MS = 4_000

// 标签页标题：脉搏给等你决定的数量，顶栏给当前页面与空间（setTitleContext），两边各管各的，谁变了都重拼一次
const title: { waiting: number; page?: string; space?: string } = { waiting: 0 }
const applyTitle = () => void (document.title = pulseTitle(title.waiting, title.page, title.space))
export function setTitleContext(page?: string, space?: string) {
  title.page = page
  title.space = space
  applyTitle()
}

const OUTCOME = { succeeded: { text: '已完成', tone: 'success' }, failed: { text: '失败了', tone: 'failed' }, cancelled: { text: '已取消', tone: 'pending' }, ended: { text: '已结束', tone: 'success' } } as const

/** 一件事 → 卡片文案与去处；系统通知点开也去同一个地方。 */
function card(e: PulseEvent): { title: string; body: string; tone: 'success' | 'failed' | 'pending' | 'waiting'; go: string; actions: Array<{ label: string; to: string }> } {
  if (e.type === 'run-ended') {
    const o = OUTCOME[e.outcome]
    return { title: `${e.requirementId} 运行${o.text}`, body: e.title, tone: o.tone, go: `/run/${e.runId}`, actions: [{ label: '看运行', to: `/run/${e.runId}` }, { label: '回到需求', to: `/req/${e.requirementId}` }] }
  }
  return { title: `${e.requirementId} 等你决定`, body: summaryLine(e.ask, 120), tone: 'waiting', go: '/attention', actions: [{ label: '去处理', to: '/attention' }] }
}

function setIcon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link && link.href !== href) link.href = href
}

/**
 * 脉搏（docs/design/25 §4）：外壳定时取一次当前空间总览，和上一次比——
 * 有变化才让页面刷新；标签页标题带等你决定的数量、图标带状态点；运行结束 / 新的等你决定弹卡片，
 * 页面在后台且开了浏览器通知时发系统通知。首次加载、切换空间后的第一次不提示。
 * 同时维护根元素的 data-tab-hidden：页面隐藏时所有无限动画暂停（styles/motion.css）；
 * 断开时（lib/connection）每 4 秒对一次，连接恢复（含浏览器 online 事件）就让所有查询重新拉取，错误页自己恢复（TF-075）。
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
      let offline = false
      try {
        const snap = pulseSnap(await ds.project())
        if (!alive) return
        title.waiting = snap.waiting
        applyTitle()
        setIcon(pulseIcon(snap.waiting ? 'waiting' : snap.running ? 'running' : 'idle'))
        if (prev && prev.sig !== snap.sig) {
          invalidate()
          diffPulse(prev, snap).slice(0, 3).forEach(announce)
        }
        prev = snap
      } catch (e) {
        // 取不到就等下一拍，不打断页面；断网 / 服务没了就勤一点对，恢复后由 onReconnect 让页面重新取数
        offline = isNetworkError(e)
      }
      if (alive) timer = setTimeout(() => void tick(), offline ? OFFLINE_MS : document.hidden ? HIDDEN_MS : VISIBLE_MS)
    }
    const onVisibility = () => {
      document.documentElement.toggleAttribute('data-tab-hidden', document.hidden)
      // 回到页面立刻对一次，不等下一拍
      if (!document.hidden) void tick()
    }
    // 浏览器报告断网立刻显示断开；联网后马上对一次，连上了 reportConnection 会触发重新取数
    const onOffline = () => reportConnection(false)
    const onOnline = () => void tick()
    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    const offReconnect = onReconnect(invalidate)
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
      offReconnect()
    }
  }, [ds, spaceId])
}
