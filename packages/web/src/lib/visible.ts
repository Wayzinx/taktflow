/**
 * 浏览器对同一地址最多 6 条 HTTP/1.1 连接，所有标签页共用。每个页面挂着 1–3 条 SSE 长连接，开三四个标签就占满，
 * 之后任何请求都排队，页面停在加载中。后台标签页隐藏超过 HIDDEN_GRACE_MS 就断开长连接，回到前台再连上；
 * 短暂切走（看一眼别的标签）不断，免得来回重连。
 */
export const HIDDEN_GRACE_MS = 10_000

/** 页面可见时保持 open() 打开的连接，隐藏够久就关掉，可见时再开。返回值彻底关闭。 */
export function whileVisible(open: () => () => void): () => void {
  // 非浏览器环境（node 里跑的接口契约测试）没有可见性，直接连
  if (typeof document === 'undefined') return open()
  let close: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const onChange = () => {
    if (!document.hidden) {
      clearTimeout(timer)
      timer = undefined
      close ??= open()
      return
    }
    timer ??= setTimeout(() => {
      timer = undefined
      close?.()
      close = undefined
    }, HIDDEN_GRACE_MS)
  }
  // 在后台打开的标签（⌘ 点击）等到可见再连
  if (!document.hidden) close = open()
  document.addEventListener('visibilitychange', onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    clearTimeout(timer)
    close?.()
    close = undefined
  }
}

/** 标签页隐藏够久（长连接已断）后回到前台时调用 cb：没有游标可补的流靠它重新拉一次。 */
export function onTabReturn(cb: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  let hiddenAt = document.hidden ? Date.now() : undefined
  const onChange = () => {
    if (document.hidden) {
      hiddenAt ??= Date.now()
      return
    }
    if (hiddenAt !== undefined && Date.now() - hiddenAt >= HIDDEN_GRACE_MS) cb()
    hiddenAt = undefined
  }
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
