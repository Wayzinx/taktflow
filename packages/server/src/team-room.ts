import type { Actor, ProjectStores, RequirementCreateResponse } from '@taktflow/core'
import { actor, authorize, body, HttpError, safeId, text } from './http.js'
import { commandExecutor, type M3Callbacks } from './m3-routes.js'
import type { Handler } from './routes.js'
import { roomContext, teamChat, vibePrompt } from './team-room-context.js'
import { teamRoomStore, type TeamChannel, type TeamMessage, type TeamReply } from './team-room-store.js'

interface TeamNode { id: string; harness: string; online: boolean }
export interface TeamJob { id: string; nodeId: string; harness: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; result?: unknown }
interface TeamHub {
  teamNodes(stores: ProjectStores): TeamNode[] | Promise<TeamNode[]>
  teamJobs(stores: ProjectStores): TeamJob[] | Promise<TeamJob[]>
  enqueueTeamJob(stores: ProjectStores, task: { id: string; nodeId: string; harness: string; prompt: string; actorId: string }): Promise<{ id: string }>
}

function bounded(value: unknown, field: string, limit: number): string {
  const valueText = text(value, field)
  if (valueText.length > limit) throw new HttpError(400, `${field} 不能超过 ${limit} 个字符`)
  return valueText
}

type TeamInput = { requestId: string; text: string } & (
  { mode: 'chat' } | { mode: 'workflow'; workflowId: string; includeDiscussion: boolean } | { mode: 'vibe'; nodeId: string; harness?: string }
)

function parse(input: Record<string, unknown>): TeamInput {
  const fields = { requestId: bounded(input.requestId, 'requestId', 200), text: bounded(input.text, 'text', 32_000) }
  const { mode } = input
  if (mode !== 'chat' && mode !== 'workflow' && mode !== 'vibe') throw new HttpError(400, '不支持的团队消息模式')
  if ((mode !== 'workflow' && input.workflowId !== undefined) || (mode !== 'vibe' && (input.nodeId !== undefined || input.harness !== undefined))) {
    throw new HttpError(400, '工作流或节点参数与消息模式不匹配')
  }
  if (mode === 'workflow') {
    const workflowId = safeId(bounded(input.workflowId, 'workflowId', 200).trim())
    if (workflowId.endsWith('.ts')) throw new HttpError(400, '请选择已登记的流程 ID')
    if (input.includeDiscussion !== undefined && typeof input.includeDiscussion !== 'boolean') throw new HttpError(400, 'includeDiscussion 必须是布尔值')
    return { ...fields, mode, workflowId, includeDiscussion: input.includeDiscussion === true }
  }
  if (mode === 'vibe') return { ...fields, mode, nodeId: bounded(input.nodeId, 'nodeId', 200).trim(),
    harness: input.harness === undefined ? undefined : bounded(input.harness, 'harness', 200).trim() }
  return { ...fields, mode }
}

function title(message: string): string {
  const chars = [...message.trim().split(/\r?\n/, 1)[0]!.replace(/\s+/g, ' ')]
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : chars.join('')
}

async function savedRun(stores: ProjectStores, requirementId: string, workflowId?: string) {
  const runs = await stores.runs.list({ requirementId })
  return runs.filter(run => !workflowId || run.workflowId === workflowId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.runId
}

async function recoverWorkflow(stores: ProjectStores, id: string, startError: string, workflowId?: string): Promise<TeamReply> {
  if (!await stores.workspaces.getRequirement(id)) return { text: `未确认需求已创建：${startError}。请检查后再提交。` }
  const runId = await savedRun(stores, id, workflowId)
  return { requirementId: id, runId, startError,
    text: `已找到需求 ${id}${runId ? ` 和运行 ${runId}` : ''}，但提交未完整确认：${startError}。请在需求页核对，不会重复启动。` }
}

async function nodeTask(stores: ProjectStores, hub: TeamHub, task: { id: string; nodeId: string; harness?: string; actorId: string },
  prompt: () => Promise<string>): Promise<TeamReply> {
  const matching = (await hub.teamNodes(stores)).filter(node => node.id === task.nodeId && (!task.harness || node.harness === task.harness))
  const online = matching.filter(node => node.online)
  if (!online.length) return { text: '未派发作业：所选节点或 harness 当前不可用，请检查在线节点后重新提交。' }
  if (online.length > 1) return { text: '未派发作业：节点有多个在线 harness，请明确选择后重新提交。' }
  const job = await hub.enqueueTeamJob(stores, { ...task, harness: online[0]!.harness, prompt: await prompt() })
  return { jobId: job.id, text: `已将作业 ${job.id} 派发给节点 ${task.nodeId}（${online[0]!.harness}），可在作业列表查看进度。` }
}

async function recoverJob(stores: ProjectStores, hub: TeamHub, id: string): Promise<TeamReply> {
  if ((await hub.teamJobs(stores)).some(job => job.id === id)) return { jobId: id, text: `已找到作业 ${id}，不会重复派发。请在作业列表查看进度。` }
  return { text: '未能确认作业已入队。请检查作业列表和节点状态，确认没有相同作业再重新提交。' }
}

export type TeamHuman = Extract<Actor, { type: 'human' }>
interface TeamTurnOptions {
  operationKey?: string
  beforeRecord?: () => Promise<void>
}
interface TeamSubmitOptions extends TeamTurnOptions { discussion?: string; displayText?: string }

export function formatDiscussion(history: TeamMessage[]): string {
  return history.slice(-8).map(message => `${message.author}（${message.role}）: ${message.text.slice(0, 800)}`).join('\n')
}

export function teamRoomService(stores: ProjectStores, options: M3Callbacks, hub: TeamHub,
  currentStores: () => Promise<ProjectStores> = async () => stores, source?: TeamChannel) {
  const { executeAs } = commandExecutor(options)
  const room = teamRoomStore(stores.taktDir)
  const record = (by: TeamHuman, requestId: string, fingerprint: object, message: string,
    respond: (live: ProjectStores, id: string, history: TeamMessage[], interrupted: boolean) => Promise<TeamReply>, turn: TeamTurnOptions = {}) =>
    room.submit(by.id, requestId, fingerprint, message, async (id, history, interrupted) => respond(await currentStores(), id, history, interrupted),
      { ...turn, guard: currentStores, source })
  return {
    record,
    submit(by: TeamHuman, input: TeamInput, turnOptions: TeamSubmitOptions = {}) {
      const { displayText, discussion: captured, ...turn } = turnOptions
      return record(by, input.requestId, turn.operationKey ? { operation: turn.operationKey } : input, displayText ?? input.text,
        async (live, id, history, interrupted) => {
          const author = by.id
          const turn = { author, text: input.text }
          if (input.mode === 'workflow') {
            const requirementId = `TEAM-${id}`
            if (interrupted) return recoverWorkflow(live, requirementId, '上次提交中断')
            const discussion = captured ?? (input.includeDiscussion ? formatDiscussion(history) : '')
            const description = discussion ? `${input.text}\n\n## 讨论记录（供参考）\n${discussion}` : input.text
            let result: RequirementCreateResponse
            try {
              result = await executeAs(live, by, 'requirement.create', {
                id: requirementId, title: title(input.text), description, owner: author, workflowId: input.workflowId, start: true,
              }) as RequirementCreateResponse
            } catch (error) {
              return recoverWorkflow(live, requirementId, error instanceof HttpError ? error.message : '创建命令未完成', input.workflowId)
            }
            const runId = result.runId ?? (result.startError ? await savedRun(live, requirementId, input.workflowId) : undefined)
            return { requirementId: result.requirement.id, runId, startError: result.startError,
              text: `已创建需求 ${result.requirement.id}${runId ? `，已记录运行 ${runId}` : ''}${result.startError ? `，但启动命令报告失败：${result.startError}` : ''}。` }
          }
          const context = async () => roomContext(history, history.some(message => message.jobId) ? await hub.teamJobs(live) : [])
          if (input.mode === 'vibe') {
            const jobId = `team-${id}`
            if (interrupted) return recoverJob(live, hub, jobId)
            try {
              return await nodeTask(live, hub, { id: jobId, nodeId: input.nodeId, harness: input.harness, actorId: author },
                async () => vibePrompt(await context(), turn))
            } catch { return recoverJob(live, hub, jobId) }
          }
          return { text: await teamChat(live, await context(), turn) }
        }, turn)
    },
  }
}

export function teamRoomRoutes(add: (method: string, path: string, handler: Handler) => void, options: M3Callbacks, hub: TeamHub) {
  const snapshot = async (stores: ProjectStores) => {
    const [messages, nodes, jobs] = await Promise.all([teamRoomStore(stores.taktDir).messages(), hub.teamNodes(stores), hub.teamJobs(stores)])
    return { messages, nodes: nodes.map(({ id, harness, online }) => ({ id, harness, online })),
      jobs: jobs.map(({ id, nodeId, harness, status, result }) => ({ id, nodeId, harness, status, result })) }
  }
  add('GET', '/api/space/team', ({ stores, request, response }) => {
    response.setHeader('cache-control', 'private, no-store')
    authorize(request, stores, 'viewer', '查看团队会话')
    return snapshot(stores)
  })
  add('POST', '/api/space/team/messages', async ({ stores, request }) => {
    authorize(request, stores, 'member', '发送团队消息')
    const input = parse(await body(request, false, 256 * 1024))
    await teamRoomService(stores, options, hub).submit(actor(request, stores) as TeamHuman, input)
    return snapshot(stores)
  })
}
