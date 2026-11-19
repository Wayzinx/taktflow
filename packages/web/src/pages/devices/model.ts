import type { Viewer } from '@taktflow/core'
import { ApiRequestError } from '../../api/client.js'

export const LINK_DOWNLOAD = '/downloads/taktflow-link.mjs'
export const PLATFORM_LABEL = { mac: 'Mac', linux: 'Linux' } as const

export const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const ROLE_LABELS = {
  owner: 'Owner · 所有者',
  maintainer: 'Maintainer · 维护者',
  member: 'Member · 成员',
  viewer: 'Viewer · 访客',
} satisfies Record<NonNullable<Viewer['member']>['role'], string>

export function canManageDevices(viewer: Viewer | undefined, explicitUser: string | undefined, mock: boolean): boolean {
  return !mock && viewer?.member?.role === 'owner' && (explicitUser === undefined || viewer.id === explicitUser)
}

export function hubAddress(origin: string): string {
  const url = new URL(origin)
  if (url.protocol === 'http:' && url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url.origin
}

export function linkHub(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value.trim()) || /[?#]/.test(value)) return
  try {
    const url = new URL(value)
    if (url.username || url.password || url.pathname !== '/') return
    if (url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return hubAddress(url.origin)
  } catch {
    return undefined
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function linkCommand(hub: string, spaceId: string, nodeId: string): string {
  return `node ~/Downloads/taktflow-link.mjs --hub ${quote(hub)} --space ${quote(spaceId)} --node ${quote(nodeId)}`
}

export function linkDownloadCommand(hub: string): string {
  return `mkdir -p ~/Downloads && curl -fL ${quote(hub + LINK_DOWNLOAD)} -o ~/Downloads/taktflow-link.mjs`
}

export function loopbackHub(hub: string): boolean {
  const hostname = new URL(hub).hostname
  return hostname === 'localhost' || hostname.endsWith('.localhost') || /^127(?:\.\d+){3}$/.test(hostname) || hostname === '[::1]'
}

export const authDenied = (error: unknown): boolean => error instanceof ApiRequestError && (error.status === 401 || error.status === 403)

export function deviceError(error: unknown, operation: 'read' | 'link' | 'revoke'): string {
  if (authDenied(error)) return operation === 'read' ? '当前身份无法查看设备。请确认你是此空间的成员。'
    : '操作被拒绝。请确认你已明确选择此空间的 Owner 身份，然后刷新页面。'
  if (error instanceof ApiRequestError) {
    if (error.status === 404) return operation === 'revoke' ? '设备已不存在，请刷新列表。' : '此空间或 Hub 的设备接口不可用。请检查空间和 Hub 版本。'
    if (error.status === 409) return operation === 'link' ? '此设备 ID 已被占用，请重新添加电脑。' : '设备当前无法撤销。请刷新列表后重试。'
    if (error.status === 400 && operation === 'link') return 'Hub 无法登记这台电脑，请检查电脑名称、系统和 Hub 版本。'
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'Hub 响应超时。请检查连接后重试。'
  return '无法完成请求。请检查 Hub 连接后重试。'
}
