/**
 * 嵌入模式开关（dsh 插件主面板 / 会话 Tab）。
 *
 * 嵌入时宿主已经提供导航、对话（需求群就是宿主会话）、主题和快捷键：
 * 本应用不显示侧栏和空间切换、不注册全局快捷键、不显示群聊 Tab，也不写页面全局状态。
 * 由 embed.tsx 在挂载前设置；独立页面始终是 false。
 */
let embedded = false

export function setEmbedded(value: boolean): () => void {
  const prev = embedded
  embedded = value
  return () => {
    embedded = prev
  }
}

export function isEmbedded(): boolean {
  return embedded
}
