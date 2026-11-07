import type { ReactNode } from 'react'
import { viewTransitionsEnabled } from '../../lib/router'

/**
 * 路由转场（体验基线 3），由 components/layout 包住 <main> 的内容：
 * - 浏览器支持 View Transitions 时：lib/router 的 navigate / 前进后退用 document.startViewTransition 包住渲染，
 *   这里只给内容加 view-transition-name: page（styles/motion.css：旧页淡出 120ms、新页淡入 + 上移 6px 200ms）；
 * - 不支持时：按 routeKey 重挂载并播 .page-enter（没有退出帧）。
 * 只改查询参数（Tab、选中的节点）不触发转场。
 *   <PageTransition routeKey={spaceId + path}>{children}</PageTransition>
 */
export function PageTransition({ routeKey, children }: { routeKey: string; children: ReactNode }) {
  if (viewTransitionsEnabled()) return <div className="page-view">{children}</div>
  return (
    <div key={routeKey} className="page-view page-enter">
      {children}
    </div>
  )
}

/**
 * 共享元素过渡名：列表和详情上的同一个东西用同一个名字，View Transitions 会把它从旧位置移到新位置。
 * 同一时刻页面上一个名字只能出现一次（列表里每行的名字各不相同）。
 *   <span style={{ viewTransitionName: vtName('req', r.id) }}>{r.title}</span>   // 需求列表的标题
 *   <PageHeader titleTransitionName={vtName('req', id)} …/>                       // 需求详情的标题
 */
export function vtName(kind: string, id: string): string {
  return `${kind}-${id}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}
