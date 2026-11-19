import { execFileSync } from 'node:child_process'
import type { Viewer } from '@taktflow/core'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../../api/client.js'
import { canManageDevices, deviceError, hubAddress, linkCommand, linkHub, linkDownloadCommand, loopbackHub } from './model.js'

describe('设备配对', () => {
  it('从浏览器地址派生 Hub，保留 HTTPS 和端口', () => {
    expect(hubAddress('http://localhost:4870')).toBe('http://127.0.0.1:4870')
    expect(hubAddress('https://localhost:4870')).toBe('https://localhost:4870')
    expect(hubAddress('https://hub.example/s/alpha/devices?theme=light')).toBe('https://hub.example')
  })

  it('仅接受 HTTPS 或本机 HTTP 隧道，拒绝地址中的额外数据', () => {
    expect(linkHub('https://hub.example:4870/')).toBe('https://hub.example:4870')
    expect(linkHub('http://localhost:8765')).toBe('http://127.0.0.1:8765')
    expect(linkHub('http://[::1]:8765')).toBe('http://[::1]:8765')
    for (const address of ['http://hub.example', 'https://alice@hub.example', 'https://hub.example/#', 'https://hub.example/?', 'https://hub.example/path', 'file:///tmp/hub']) {
      expect(linkHub(address)).toBeUndefined()
    }
  })

  it('命令将所有动态参数按 POSIX shell 字面量传递', () => {
    const hub = 'https://hub.example'
    const space = 'space with spaces'
    const nodeId = "node'$(printf expanded);*"
    const command = linkCommand(hub, space, nodeId)
    const args = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).split('\0')
    expect(args.slice(0, -1)).toEqual(['node', `${process.env.HOME}/Downloads/taktflow-link.mjs`, '--hub', hub, '--space', space, '--node', nodeId])
  })

  it('识别回环 Hub，并向无桌面的 Linux 提供同源 Link 下载命令', () => {
    expect(loopbackHub('http://127.0.0.1:4870')).toBe(true)
    expect(loopbackHub('http://[::1]:4870')).toBe(true)
    expect(loopbackHub('https://127.example.com')).toBe(false)
    expect(linkDownloadCommand('https://hub.example')).toBe("mkdir -p ~/Downloads && curl -fL 'https://hub.example/downloads/taktflow-link.mjs' -o ~/Downloads/taktflow-link.mjs")
  })

  it('支持网关或本地选择器确认的空间 Owner', () => {
    const owner: Viewer = { id: 'alice', name: 'Alice', member: { id: 'alice', name: 'Alice', role: 'owner' } }
    expect(canManageDevices(owner, 'alice', false)).toBe(true)
    expect(canManageDevices(owner, 'alice', true)).toBe(false)
    expect(canManageDevices(owner, undefined, false)).toBe(true)
    expect(canManageDevices(owner, 'bob', false)).toBe(false)
    for (const role of ['maintainer', 'member', 'viewer'] as const) {
      expect(canManageDevices({ ...owner, member: { ...owner.member!, role } }, 'alice', false)).toBe(false)
    }
    expect(canManageDevices({ ...owner, member: undefined }, 'alice', false)).toBe(false)
  })

  it('给出可操作的错误提示，不回显 Hub 响应正文', () => {
    const message = 'fixture-only'
    expect(deviceError(new ApiRequestError(403, message), 'link')).toContain('Owner')
    expect(deviceError(new ApiRequestError(409, message), 'link')).toContain('ID 已被占用')
    expect(deviceError(new ApiRequestError(404, message), 'revoke')).toContain('已不存在')
    expect(deviceError(new ApiRequestError(500, message), 'read')).not.toContain(message)
    expect(deviceError(new DOMException('test', 'TimeoutError'), 'read')).toContain('超时')
  })
})
