import { createContext, useContext } from 'react'
import { Lock } from 'lucide-react'
import type { SpaceMember, Viewer } from '@taktflow/core'
import { accessOf } from './rules'

/** 设置页的当前身份：SettingsPage 取一次 GET /me，各 Tab 按自己的门槛决定能不能改。 */
export const SettingsViewer = createContext<Viewer | undefined>(undefined)

export function useAccess(min: SpaceMember['role'], what: string) {
  return accessOf(useContext(SettingsViewer), min, what)
}

/** 没有权限时放在卡片顶部的一行说明（block：不在卡片里时自带边框）；控件本身由调用方禁用或隐藏。 */
export function ReadOnlyNote({ why, block }: { why?: string; block?: boolean }) {
  if (!why) return null
  return (
    <p className={`settings-ro-note${block ? ' is-block' : ''}`} role="note">
      <Lock aria-hidden />
      {why}
    </p>
  )
}
