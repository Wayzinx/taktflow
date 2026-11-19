import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProjectStores } from '@taktflow/core'
import { body, HttpError, json, text } from './http.js'
import { pollTeamJob, TEAM_LEASE_MS, TEAM_RESULT_BYTES, teamId, updateTeamClaim } from './team-hub.js'

export const TEAM_WORKER_PATH = '/api/team-worker/'
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const key = (space: string, node: string) => `${space}/${node}`
const hash = (token: string) => createHash('sha256').update(token).digest()

function admissions(raw: string | undefined) {
  const nodes = new Map<string, { harness: string; digest: Buffer }>()
  const used = new Set<string>()
  if (raw === undefined) return nodes
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error()
    for (const entry of value) {
      const { spaceId, nodeId, harness, token } = entry ?? {}
      if (typeof token !== 'string' || !TOKEN.test(token) || used.has(token)) throw new Error()
      const id = key(teamId(text(spaceId, 'spaceId')), teamId(text(nodeId, 'nodeId')))
      if (nodes.has(id)) throw new Error()
      nodes.set(id, { harness: teamId(text(harness, 'harness')), digest: hash(token) })
      used.add(token)
    }
    return nodes
  } catch {
    throw new Error('TAKT_TEAM_NODES 必须是合法的 [{spaceId,nodeId,harness,token}]，节点与 32–256 字符的 URL-safe token 不可重复')
  }
}

function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function teamWorkerApi(raw: string | undefined, storesFor: (spaceId: string) => Promise<ProjectStores | undefined>) {
  const nodes = admissions(raw)
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    response.setHeader('cache-control', 'no-store')
    const route = /^\/api\/team-worker\/v1\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(poll|heartbeat|finish)$/.exec(url.pathname)
    if (!nodes.size || !route || request.method !== 'POST') throw new HttpError(404, 'Worker API 不存在')
    if (!loopback(request.socket.remoteAddress) || request.headers.origin !== undefined) throw new HttpError(403, 'Worker API 只接受本机、TLS 反代或隧道连接')
    const space = route[1]!, node = route[2]!, action = route[3]
    const admission = nodes.get(key(space, node))
    const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.authorization ?? '')?.[1]
    if (!admission || !token || !timingSafeEqual(admission.digest, hash(token))) throw new HttpError(401, 'Worker 凭据不匹配')
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Worker 请求必须使用 application/json')
    const stores = await storesFor(space)
    if (!stores) throw new HttpError(404, '空间不存在')
    const input = await body(request, false, action === 'finish' ? 128 * 1024 : 2048)
    if (input.harness !== admission.harness) throw new HttpError(403, 'Worker harness 不匹配')
    const worker = { id: node, harness: admission.harness, session: teamId(text(input.session, 'session')) }
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
  }
}
