/**
 * 组件需要写"页面级"状态（CSS 变量、拖动中的光标类）时用的根节点：
 * 嵌入模式是最近的 `.takt-root`，独立页面是 documentElement / body。不碰宿主的全局节点。
 */
export function scopeRoot(el: Element | null | undefined): { vars: HTMLElement; classes: HTMLElement } {
  const root = el?.closest<HTMLElement>('.takt-root')
  if (root) return { vars: root, classes: root }
  return { vars: document.documentElement, classes: document.body }
}
