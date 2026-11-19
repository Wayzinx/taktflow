import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProjectStores } from '@taktflow/core'
import { body, HttpError, json, text } from './http.js'
import { WORKER_TOKEN, type TeamAdmissions } from './team-admissions.js'
import { pollTeamJob, TEAM_LEASE_MS, TEAM_RESULT_BYTES, teamId, updateTeamClaim } from './team-hub.js'

export const TEAM_WORKER_PATH = '/api/team-worker/'

function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function teamWorkerApi(admissions: TeamAdmissions, storesFor: (spaceId: string) => Promise<ProjectStores | undefined>) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    response.setHeader('cache-control', 'no-store')
    const route = /^\/api\/team-worker\/v1\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(link|poll|heartbeat|finish)$/.exec(url.pathname)
    if (!route || request.method !== 'POST') throw new HttpError(404, 'Worker API 不存在')
    if (!loopback(request.socket.remoteAddress) || request.headers.origin !== undefined) throw new HttpError(403, 'Worker API 只接受本机、TLS 反代或隧道连接')
    const space = route[1]!, node = route[2]!, action = route[3]
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Worker 请求必须使用 application/json')
    const input = await body(request, false, action === 'finish' ? 128 * 1024 : 2048)
    if (action === 'link') {
      if (input.harness !== 'codex') throw new HttpError(400, 'Team Link 仅支持 codex')
      if (typeof input.code !== 'string' || !WORKER_TOKEN.test(input.code)) throw new HttpError(401, 'Team Link 连接码无效或已失效')
      if (!await storesFor(space)) throw new HttpError(404, '空间不存在')
      json(response, await admissions.exchange(space, node, input.code))
      return
    }
    const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.authorization ?? '')?.[1]
    await admissions.authorize(space, node, token, async admission => {
      if (input.harness !== admission.harness) throw new HttpError(403, 'Worker harness 不匹配')
      const stores = await storesFor(space)
      if (!stores) throw new HttpError(404, '空间不存在')
      const generation = 'generation' in admission ? admission.generation : undefined
      const worker = { id: node, harness: admission.harness, session: teamId(text(input.session, 'session')), generation }
      if (action === 'poll') {
        if (typeof input.poll !== 'number' || !Number.isSafeInteger(input.poll) || input.poll < 1) throw new HttpError(400, 'Worker 轮询序号不合法')
        json(response, await pollTeamJob(stores, worker, input.poll))
        return
      }
      const id = teamId(text(input.id, 'id'))
      const claimId = teamId(text(input.claimId, 'claimId'))
      if (action === 'heartbeat') {
        await updateTeamClaim(stores, worker, id, claimId)
        json(response, { leaseMs: TEAM_LEASE_MS })
        return
      }
      const { status, result } = input
      if ((status !== 'succeeded' && status !== 'failed') || typeof result !== 'string' || Buffer.byteLength(result) > TEAM_RESULT_BYTES) {
        throw new HttpError(400, 'Worker 结果状态不合法或超过 16 KiB')
      }
      json(response, await updateTeamClaim(stores, worker, id, claimId, { status, result }))
    })
  }
}
