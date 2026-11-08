import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createEngine, createLeadRuntime, initProject, openProject, nodeQuality, type AgentProfile, type HarnessAdapter, type EventPayloads, type DefectDetail, type RoomMessage } from '@taktflow/core'
import { createServer, type RunningServer, type ServerOptions } from './index.js'
import { startMaintenance } from './maintenance.js'
import { protectCandidate } from '../../core/src/eval/candidates.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()))
  for (const root of roots.splice(0)) {
    await protectCandidate(join(root, '.takt/quality/candidates'), true).catch(e => { if (e.code !== 'ENOENT') throw e })
    await rm(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
async function fixture(options: Partial<ServerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-m5-http-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: 'M5 接线' })
  const profiles = Object.fromEntries(['dev', 'reviewer', 'evaluator'].map(role => [role, { role, title: role, description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock', model: role } } satisfies AgentProfile]))
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), run: async request => {
    if (request.env?.TAKT_ROLE === 'evaluator') return { ok: true, finalText: '', structured: { outcome: 'pass', reason: 'mock 材料核对' } }
    return { ok: true, finalText: '', structured: { verdict: 'approve', summary: '已核对', issues: [] } }
  } }
  const state = await createEngine({ stores, profiles, harnesses: { mock: harness }, knowledge: [] }).start({ requirementId: req.id, workflow: {
    id: 'flow', title: 'M5', version: '1', stages: [], nodes: [
      { kind: 'script', id: 'write', title: '新增', outputs: [{ path: 'spec.md', kind: 'spec' }], run: async ctx => { await writeFile(join(ctx.workspaceDir, 'spec.md'), '字段缺失') } },
      { kind: 'review', id: 'review', title: '检查', needs: ['write'], target: ['spec.md'], reviewers: [{ role: 'reviewer', checklist: ['字段完整'] }], author: { role: 'dev' }, maxRounds: 1 },
      { kind: 'gate', id: 'gate', title: '门禁', needs: ['review'], checks: [{ id: 'check', kind: 'function', fn: async () => ({ id: 'check', pass: true }) }] },
    ],
  } })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  const server = await createServer({ projectDir: root, port: 0, resolveRuntime: fresh => ({ stores: fresh, profiles, harnesses: { mock: harness }, knowledge: [] }), ...options }); servers.push(server)
  const call = async (path: string, method = 'GET', input?: unknown, status = 200) => {
    const response = await fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) }) })
    const data = await response.json()
    expect(response.status, JSON.stringify(data)).toBe(status)
    return data
  }
  const point = (await nodeQuality(stores, state.runId, 'review')).checkpoints.find(p => p.role === 'reviewer')!
  return { root, stores, req, state, server, call, point, profiles, harness }
}
it('读模型、时间身份、快照与 diff 路径防穿越；质量同步原因可回读', async () => {
  const f = await fixture(), base = `/api/runs/${f.state.runId}`
  const detail = await f.call(`${base}/nodes/review`)
  expect(detail).toMatchObject({ checkpoints: [{ id: f.point.id, status: 'done' }], invocations: [{ attempt: 1, fallbackIndex: 0 }], issues: [], changes: { files: expect.any(Array) } })
  expect((await f.call(`${base}/nodes/gate`)).gate).toMatchObject({ pass: true, checks: [{ status: 'pass', checkpointId: expect.any(String) }] })
  const timeline = await f.call(`${base}/timeline`)
  expect(timeline.lanes.find((l: any) => l.nodeId === 'review').invocations).toMatchObject([{ attempt: 1, fallbackIndex: 0 }])
  const snapshot = `${base}/snapshots/${encodeURIComponent(f.point.id)}`
  expect(await f.call(snapshot)).toMatchObject({ checkpointId: f.point.id })
  expect(await f.call(`${snapshot}/file?path=target%2Fspec.md`)).toMatchObject({ path: 'target/spec.md', content: '字段缺失', encoding: 'utf8', version: 1 })
  expect((await f.call(`${base}/nodes/write/diff?path=spec.md`)).patch).toContain('字段缺失')
  for (const path of ['../secret', '/tmp/secret', 'a/../../b', 'a\\b']) {
    await f.call(`${snapshot}/file?path=${encodeURIComponent(path)}`, 'GET', undefined, 400)
    await f.call(`${base}/nodes/write/diff?path=${encodeURIComponent(path)}`, 'GET', undefined, 400)
  }
  await f.call(`${base}/snapshots/${encodeURIComponent('../outside')}`, 'GET', undefined, 400)
  const file = join(f.stores.taktDir, f.point.snapshot!.dir, 'files/target/spec.md')
  await rm(file); await symlink(join(f.root, 'takt.config.json'), file)
  await f.call(`${snapshot}/file?path=target%2Fspec.md`, 'GET', undefined, 400)
  await rm(file); await writeFile(file, '字段缺失')
  expect(await f.call('/api/quality/sync', 'POST', { runId: f.state.runId, reason: '补齐事件观察' })).toMatchObject({ ok: true })
  expect(await readFile(join(f.stores.taktDir, 'space-events.jsonl'), 'utf8')).toContain('补齐事件观察')
  expect(await f.call('/api/quality/status')).toMatchObject({ ok: true })
})
it('回退预览与 409；新建产物保留且上下游过期，支持空间前缀', async () => {
  const f = await fixture()
  // 使用真实空间列表返回的 id，兼容 legacy 配置。
  const spaces = await f.call('/api/spaces'), base = `/api/s/${spaces[0].id}/runs/${f.state.runId}/nodes/write`
  const preview = await f.call(`${base}/rewind/preview`, 'POST')
  expect(preview.files).toMatchObject([{ path: 'spec.md', to: 1 }])
  await f.call(`${base}/rewind`, 'POST', { token: 'stale', reason: '过期预览' }, 409)
  const result = await f.call(`${base}/rewind`, 'POST', { token: preview.token, reason: '重做新增产物' })
  expect(result.files[0].version).toBeUndefined()
  const fresh = await openProject(f.root)
  expect((await fresh.workspaces.readArtifact({ workspace: f.req.id, path: 'spec.md' }))!.toString()).toBe('字段缺失')
  expect((await fresh.runs.get(f.state.runId))!.nodes.review!.status).toBe('stale')
  expect((await fresh.events.read(f.state.runId, { types: ['node.rewound'] }))[0]!.data).toMatchObject({ kept: ['spec.md'], reason: '回退到 write 之前：重做新增产物' })
})
it('观察创建缺陷、版本冲突、合并决定与撤销、五条件确认生成 must_catch 和退役', async () => {
  const f = await fixture(), base = `/api/requirements/${f.req.id}`
  const observation = { id: 'external-evidence', source: 'external' as const, kind: 'report' as const, requirementId: f.req.id, title: '字段缺失',
    artifacts: [{ workspace: f.req.id, path: 'spec.md', version: 1 }], at: new Date().toISOString(), by: { type: 'human' as const, id: 'web' } }
  await f.stores.quality!.append([{ kind: 'observation.recorded', key: observation.id, requirementId: f.req.id, data: observation, actor: observation.by }])
  expect(await f.call(`${base}/observations?source=external`)).toHaveLength(1)
  const report = { title: '字段缺失', description: '快照缺字段', severity: 'major', observations: [observation.id], reason: '人确认观察关联' }
  let defect = await f.call(`${base}/defects`, 'POST', report) as DefectDetail
  expect(defect.observationsDetail?.[0]?.id).toBe(observation.id)
  defect = await f.call(`${base}/defects/${defect.id}`, 'PATCH', { validity: 'valid', baseRevision: defect.revision, reason: '核对为真实缺陷' })
  await f.call(`${base}/defects/${defect.id}`, 'PATCH', { resolution: 'claimed_fixed', baseRevision: 1, reason: '旧版本编辑' }, 409)
  await f.call(`${base}/defects`, 'POST', report)
  const suggestions = await f.call(`${base}/defects/merge-suggestions`)
  expect(suggestions).toHaveLength(1)
  expect(await f.call(`${base}/defects/merge-suggestions/${suggestions[0].id}`, 'POST', { decision: 'accept', reason: '同一根因' })).toMatchObject({ status: 'accepted' })
  expect(await f.call(`${base}/defects/merge-suggestions/${suggestions[0].id}`, 'POST', { decision: 'undo', reason: '撤销分组' })).toMatchObject({ status: 'undone' })
  defect = await f.call(`${base}/defects/${defect.id}/checkpoints/${encodeURIComponent(f.point.id)}`, 'POST', {
    verdict: 'should_have_caught', conditions: { existed: true, materialProvided: true, inDuty: true, executed: true, notRaised: true }, note: '逐项核对冻结字段，缺陷在检查前存在且输出未指出',
  })
  expect(defect.attribution?.checkpoints?.[0]?.confirmed?.by.type).toBe('human')
  const sample = await f.call('/api/eval/samples', 'POST', { kind: 'must_catch', checkpointId: f.point.id, defectId: defect.id, baseRevision: defect.revision, reason: '人确认漏检样本' })
  expect(sample.sample).toMatchObject({ kind: 'must_catch', checkpointId: f.point.id, snapshot: f.point.snapshot!.dir })
  expect(await f.call(`/api/eval/samples/${sample.id}/retire`, 'POST', { reason: '不再适用' })).toMatchObject({ sample: { retiredAt: expect.any(String) } })
  expect(await f.call('/api/eval/cases')).toEqual([])
  for (const retired of ['0', 'false']) expect(await f.call(`/api/eval/cases?retired=${retired}`)).toEqual([])
  for (const retired of ['1', 'true']) {
    expect(await f.call(`/api/eval/cases?retired=${retired}`)).toMatchObject([{ id: sample.id, title: sample.title, sample: { retiredAt: expect.any(String) } }])
    expect(await f.call(`/api/eval/cases?target=node:other/review&retired=${retired}`)).toEqual([])
  }
})
it('质量锚点落后可修，篡改修复返回 409，理由必填', async () => {
  const f = await fixture()
  await f.call('/api/quality/sync', 'POST', { reason: '初始化' })
  await f.server.close()
  await rm(join(f.stores.taktDir, 'quality/anchor.json'))
  const server = await createServer({ projectDir: f.root, port: 0 }); servers.push(server)
  const post = (body: unknown) => fetch(`${server.url}/api/quality/repair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await post({})).status).toBe(400)
  expect((await post({ reason: '补齐落后锚点' })).status).toBe(200)
  await server.close()
  const path = join(f.stores.taktDir, 'quality/log.jsonl')
  const lines = (await readFile(path, 'utf8')).trim().split('\n'), first = JSON.parse(lines[0]!)
  first.data.reason = '篡改'; lines[0] = JSON.stringify(first); await writeFile(path, lines.join('\n') + '\n')
  const corrupt = await createServer({ projectDir: f.root, port: 0 }); servers.push(corrupt)
  const response = await fetch(`${corrupt.url}/api/quality/repair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '不可自动修' }) })
  expect(response.status).toBe(409)
  expect((await response.json()).error).toContain('人工')
})
it('任务重发实际创建运行、推进回执，按回复链拒绝重复并校验 Lead 可用性', async () => {
  let lead: ReturnType<typeof createLeadRuntime> | undefined
  const resend = vi.fn<NonNullable<ServerOptions['resendTask']>>(async (_dir, id, message, reason) => lead?.resendTask(id, message, reason))
  const f = await fixture({ resendTask: resend }), base = `/api/requirements/${f.req.id}/room/tasks`
  const runtime = createLeadRuntime({ stores: f.stores, profiles: f.profiles, harnesses: { mock: f.harness }, engineFactory: deps => createEngine({ ...deps, knowledge: [] }) })
  const trigger = await f.stores.chat.post(f.req.id, { author: { type: 'human', id: 'owner' }, kind: 'text', text: '@lead 检查字段' })
  const task = { role: 'dev', title: '检查字段', instructions: '核对字段', review: false as const }
  const dispatched = await runtime.executeAction({ type: 'dispatch_task', task }, f.req.id, trigger, undefined, 0)
  expect(dispatched.ok).toBe(true)
  await runtime.drain()
  const originalRun = (await f.stores.runs.get(dispatched.refs!.taskRunId!))!
  originalRun.origin = { ...originalRun.origin!, hops: 3, chain: ['upstream'] }
  await f.stores.runs.save(originalRun)
  const original = (await f.stores.chat.list(f.req.id)).find(message => message.refs?.taskRunId === originalRun.runId && message.receipt?.status === 'sent')!
  // 模拟无人接手后的过期回执；旧格式回执与派发消息均回复触发消息。
  const expired = await f.stores.chat.post(f.req.id, { author: { type: 'system', id: 'test' }, kind: 'task', text: '原任务已过期', replyTo: trigger.id,
    refs: original.refs, receipt: { status: 'expired', hops: 3, chain: ['upstream'] } })
  const noLead = await f.call(`${base}/${original.id}/resend`, 'POST', { reason: '未启动 Lead' }, 409)
  expect(noLead.error).toContain('takt serve')
  expect(await f.stores.chat.list(f.req.id)).toContainEqual(expired)
  lead = runtime
  resend.mockClear()
  const responses = await Promise.all([1, 2].map(() => fetch(`${f.server.url}${base}/${original.id}/resend`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '人核对后重发' }),
  })))
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  const retry = await responses.find(response => response.status === 200)!.json() as RoomMessage
  expect(resend).toHaveBeenCalledTimes(1)
  expect(retry).toMatchObject({ kind: 'task', replyTo: original.id, receipt: { status: 'sent', note: '人核对后重发', hops: 3, chain: ['upstream'] } })
  expect(retry.refs!.taskRunId).not.toBe(originalRun.runId)
  expect(retry.refs!.runId).toBe(retry.refs!.taskRunId)
  await runtime.drain()
  const reopened = await openProject(f.root)
  const run = (await reopened.runs.get(retry.refs!.taskRunId!))!
  expect(run).toMatchObject({ status: 'succeeded', workflowId: originalRun.workflowId, args: originalRun.args,
    origin: { ...originalRun.origin, messageId: original.id } })
  expect(await reopened.runs.getWorkflow(run.runId)).toEqual(await reopened.runs.getWorkflow(originalRun.runId))
  const messages = await reopened.chat.list(f.req.id)
  expect(messages).toContainEqual(original)
  expect(messages.filter(message => message.refs?.taskRunId === run.runId).map(message => message.receipt?.status)).toEqual(['sent', 'started', 'done'])
  await f.call(`${base}/${retry.id}/resend`, 'POST', { reason: '已完成不能重发' }, 409)
  await f.call(`${base}/${expired.id}/resend`, 'POST', { reason: '旧回执不能绕过重复限制' }, 409)
  const uncertain = await f.stores.chat.post(f.req.id, { author: { type: 'system', id: 'test' }, kind: 'task', text: '重发结果不确定', replyTo: retry.id, refs: retry.refs, receipt: { status: 'uncertain' } })
  await f.call(`${base}/${original.id}/resend`, 'POST', { reason: '后续不确定仍不能重发同一原任务' }, 409)
  const again = await f.call(`${base}/${retry.id}/resend`, 'POST', { reason: '重发最新不确定的尝试' })
  expect(again.refs.taskRunId).not.toBe(run.runId)
  expect(again.replyTo).toBe(retry.id)
  await runtime.drain()
  await f.call(`${base}/${uncertain.id}/resend`, 'POST', { reason: '同一尝试不能换消息重发' }, 409)
  const lost = await f.stores.chat.post(f.req.id, { author: { type: 'system', id: 'test' }, kind: 'task', text: '状态丢失', refs: { taskRunId: 'missing' }, receipt: { status: 'expired' } })
  expect((await f.call(`${base}/${lost.id}/resend`, 'POST', { reason: '状态丢失' }, 409)).error).toContain('重新描述任务')
  const offline = await createServer({ projectDir: f.root, port: 0 }); servers.push(offline)
  const unavailable = await fetch(`${offline.url}${base}/${lost.id}/resend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '没有回调' }) })
  expect(unavailable.status).toBe(409)
  expect((await unavailable.json()).error).toContain('takt serve')
  const audit = await readFile(join(f.stores.taktDir, 'space-events.jsonl'), 'utf8')
  expect(audit).toContain('人核对后重发')
  expect(audit).toContain('oldTaskRunId')
  expect(audit).toContain(originalRun.runId)
  expect(audit).toContain(run.runId)
})
it('时限交还通过恢复入口；假设确认不改状态，改答使依赖过期；字段透出', async () => {
  const f = await fixture()
  await f.server.close()
  const state = (await f.stores.runs.get(f.state.runId))!
  state.status = 'waiting_human'; await f.stores.runs.save(state)
  const item = await f.stores.attention.create({ requestId: 'timed', runId: state.runId, requirementId: f.req.id, nodeId: 'write', kind: 'human', form: 'answer', ask: '字段', assumption: '按旧字段', timebox: { remindAfter: '0.000001m', handbackAfter: '0.000001m' } })
  let release!: () => void
  const continuing = new Promise<void>(resolve => { release = resolve })
  const resume = vi.fn(async () => continuing), maintenance = startMaintenance(() => [f.stores], resume)
  const pending = maintenance.tick()
  try {
    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(f.stores, expect.objectContaining({ requestId: item.requestId, handedBack: true })))
    // 恢复中的长运行不能挡住事件同步队列。
    await f.stores.events.append(state.runId, { type: 'gate.result', actor: { type: 'system', id: 'fixture' }, nodeId: 'gate', data: { pass: false, checks: [{ id: 'during-resume', pass: false, status: 'fail' }] } })
    await vi.waitFor(async () => expect((await f.stores.quality!.observations({ runId: state.runId })).some(o => o.subject === 'during-resume')).toBe(true), { timeout: 5000 })
  } finally { release(); await pending; await maintenance.close() }
  const server = await createServer({ projectDir: f.root, port: 0 }); servers.push(server)
  const list = await (await fetch(`${server.url}/api/attention`)).json()
  expect(list.find((i: any) => i.requestId === 'timed')).toMatchObject({ timebox: item.timebox, assumption: '按旧字段', handedBack: true, remindedAt: expect.any(Array) })
  expect(list.find((i: any) => i.kind === 'assumption')).toMatchObject({ assumedFor: 'timed' })
  const answer = await fetch(`${server.url}/api/attention/${encodeURIComponent('timed:assumption')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: '改为新字段', reason: '纠正假设' }) })
  expect(answer.status).toBe(200)
  expect((await f.stores.runs.get(state.runId))!.nodes.review!.status).toBe('stale')
})

it('serve 订阅新运行事件实时入账；agent/judge 活动与重跑 attempt 不冒充 fallback', async () => {
  const f = await fixture()
  const id = 'live-run', at = new Date().toISOString()
  await f.stores.runs.create({ runId: id, requirementId: f.req.id, workflowId: 'live', workflowVersion: '1', status: 'running', startedAt: at, args: {}, expansions: [],
    nodes: { agent: { id: 'agent', status: 'running', attempts: 1, outputs: [] }, judge: { id: 'judge', status: 'running', attempts: 2, outputs: [] } } },
  { id: 'live', title: 'live', version: '1', stages: [], nodes: [{ id: 'agent', kind: 'agent', title: '生成', role: 'dev', needs: [] }, { id: 'judge', kind: 'judge', title: '判决', role: 'judge', needs: [] }] })
  const actor = { type: 'system', id: 'test' } as const
  for (const nodeId of ['agent', 'judge']) {
    await f.stores.events.append(id, { type: 'node.started', actor, nodeId, data: { attempt: nodeId === 'judge' ? 2 : 1 } })
    await f.stores.events.append(id, { type: 'harness.started', actor, nodeId, data: { harness: 'mock', model: 'reported' } })
  }
  for (const [index, attempt, fallbackIndex] of [[0, 1, 0], [1, 1, 1], [2, 2, 0]]) {
    await f.stores.events.append(id, { type: 'invocation.started', actor, nodeId: 'judge', data: { id: `judge-${index}`, nodeId: 'judge', role: 'judge', attempt: attempt!, fallbackIndex: fallbackIndex!, harness: 'mock', model: {}, effort: {}, skills: [], at } })
  }
  const detail = await f.call(`/api/runs/${id}`)
  expect(detail.graph.nodes.filter((n: any) => ['agent', 'judge'].includes(n.id)).every((n: any) => n.activity?.state === 'thinking')).toBe(true)
  const timeline = await f.call(`/api/runs/${id}/timeline`)
  expect(timeline.lanes.find((l: any) => l.nodeId === 'judge').invocations.map((i: any) => [i.attempt, i.fallbackIndex])).toEqual([[1, 0], [1, 1], [2, 0]])
  await f.stores.events.append(id, { type: 'gate.result', actor, nodeId: 'agent', data: { pass: false, checks: [{ id: 'live-check', pass: false, status: 'fail' }] } })
  await vi.waitFor(async () => {
    expect((await f.stores.quality!.observations({ runId: id })).map(o => o.kind)).toEqual(['gate_fail'])
  }, { timeout: 5000 })
})

it('假设原文作答视为确认，保留已成功节点且审计回答', async () => {
  const f = await fixture()
  await f.stores.attention.create({ requestId: 'confirm-assumption', kind: 'assumption', form: 'answer', runId: f.state.runId, nodeId: 'write', requirementId: f.req.id, ask: '确认假设', assumption: '字段不变', assumedFor: 'original-question' })
  const item = await f.call('/api/attention/confirm-assumption', 'POST', { answer: '字段不变', reason: '确认原假设' })
  expect(item).toMatchObject({ answer: '字段不变', answeredBy: { type: 'human' } })
  expect((await f.stores.runs.get(f.state.runId))!.nodes.review!.status).toBe('succeeded')
  expect((await f.stores.events.read(f.state.runId, { types: ['human.answered'] })).some(e => (e.data as EventPayloads['human.answered']).requestId === 'confirm-assumption')).toBe(true)
})
