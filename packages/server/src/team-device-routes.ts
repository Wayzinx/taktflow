import { openProject } from '@taktflow/core'
import { join } from 'node:path'
import { body, HttpError, requestUser, requires, roleDenied, text } from './http.js'
import type { Handler, RequestContext } from './routes.js'
import { spaceId } from './space.js'
import type { TeamAdmissions } from './team-admissions.js'
import { forgetTeamDevice, teamId, teamPresence } from './team-hub.js'
import { storagePath, teamFileLock } from './team-storage.js'

const what = '管理团队设备'

function member({ request, stores }: RequestContext, owner = false): void {
  const id = requestUser(request)
  if (id && id !== 'web' && stores.config.members?.some(item => item.id === id && (!owner || item.role === 'owner'))) return
  if (owner) throw roleDenied(stores, { type: 'human', id: id ?? 'web' }, 'owner', what)
  throw new HttpError(403, '查看团队设备需要当前空间的成员身份')
}

function edit<T>(context: RequestContext, fn: (space: string) => Promise<T>): Promise<T> {
  const expected = spaceId(context.stores)
  return teamFileLock(storagePath(join(context.stores.projectDir, 'takt.config.json')), async () => {
    const fresh = await openProject(context.stores.projectDir)
    if (fresh.projectDir !== context.stores.projectDir || spaceId(fresh) !== expected) throw new HttpError(404, '空间不存在')
    member({ ...context, stores: fresh }, true)
    return fn(expected)
  })
}

export function teamDeviceRoutes(add: (method: string, path: string, handler: Handler) => void, admissions: TeamAdmissions): void {
  const path = '/api/space/devices'
  add('GET', path, async context => {
    context.response.setHeader('cache-control', 'private, no-store')
    member(context)
    const space = spaceId(context.stores)
    const presence = await teamPresence(context.stores)
    const links = await admissions.read(space)
    const env = admissions.env.get(space)
    const devices = []
    function device(nodeId: string, harness: string, source: 'env' | 'link', generation?: string) {
      const node = presence.get(nodeId)
      const seen = node?.harness === harness && node.generation === generation ? node : undefined
      return { nodeId, harness, source, status: seen?.online ? 'online' : 'offline',
        lastSeenAt: seen && new Date(seen.seenAt).toISOString(), jobId: seen?.online ? seen.jobId : undefined }
    }
    for (const entry of env?.values() ?? []) devices.push(device(entry.nodeId, entry.harness, 'env'))
    for (const entry of links?.values() ?? []) {
      if (env?.has(entry.nodeId)) continue
      if ('generation' in entry) devices.push(device(entry.nodeId, entry.harness, 'link', entry.generation))
      else if (entry.expiresAt > Date.now()) devices.push({ nodeId: entry.nodeId, harness: entry.harness, source: 'link', status: 'pending', expiresAt: new Date(entry.expiresAt).toISOString() })
    }
    return { spaceId: space, devices: devices.sort((left, right) => left.nodeId.localeCompare(right.nodeId)) }
  })
  add('POST', `${path}/link`, requires('owner', what, async (context: RequestContext) => {
    context.response.setHeader('cache-control', 'no-store')
    member(context, true)
    const input = await body(context.request, false, 2048)
    const nodeId = teamId(text(input.nodeId, 'nodeId'))
    if (input.harness !== 'codex') throw new HttpError(400, 'Team Link 仅支持 codex')
    return edit(context, space => admissions.issue(teamId(space), nodeId, () => forgetTeamDevice(context.stores, nodeId)))
  }))
  add('DELETE', `${path}/:nodeId`, requires('owner', what, async (context: RequestContext) => {
    context.response.setHeader('cache-control', 'no-store')
    member(context, true)
    const nodeId = teamId(context.params.nodeId!)
    return edit(context, space => admissions.revoke(teamId(space), nodeId, () => forgetTeamDevice(context.stores, nodeId)))
  }))
}
