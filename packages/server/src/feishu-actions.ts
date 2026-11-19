import { randomUUID } from 'node:crypto'
import { openProject, sha256, withAttentionStaleness, type AttentionItem, type ProjectStores } from '@taktflow/core'
import { feishuActionStore, type FeishuCard, type FeishuScope } from './feishu-actions-store.js'
import type { FeishuEvent } from './feishu-wire.js'
import { HttpError } from './http.js'
import { commandExecutor, type M3Callbacks } from './m3-routes.js'
import { spaceId, workflowStore } from './space.js'
import { enqueueTeamJob, teamJobs, teamNodes } from './team-hub.js'
import { formatDiscussion, teamRoomService, type TeamHuman } from './team-room.js'
import type { TeamReply } from './team-room-store.js'

export interface FeishuMessage { type: 'text' | 'interactive'; content: Record<string, unknown> }
export interface FeishuActionContext {
  bindingRevision: string
  publicBaseUrl: string
  options: M3Callbacks
  /** 可选：在取得回执锁后重新确认群、空间、绑定版本和成员映射。失效时抛出 403/409。 */
  assertCurrentBinding?: () => Promise<void>
}

const text = (content: string): FeishuMessage => ({ type: 'text', content: { text: content } })
const plain = (content: string) => ({ tag: 'plain_text', content })
const div = (content: string) => ({ tag: 'div', text: plain(content) })
const actions = (...buttons: object[]) => ({ tag: 'column_set', flex_mode: 'flow', columns: buttons.map(element => ({
  tag: 'column', width: 'auto', elements: [element],
})) })
const link = (label: string, url: string) => ({ tag: 'button', text: plain(label), behaviors: [{ type: 'open_url', default_url: url }] })
const button = (label: string, card: string, token: string, type = 'default') => ({
  tag: 'button', text: plain(label), type, behaviors: [{ type: 'callback', value: { card, token } }],
})
const interactive = (title: string, elements: object[]): FeishuMessage => ({ type: 'interactive', content: {
  schema: '2.0', config: { enable_forward: false }, header: { title: plain(title) }, body: { elements },
} })

function clip(value: string, max: number): string {
  const chars = [...value]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value
}

function links(base: string, id: string) {
  const root = `${base.replace(/\/+$/, '')}/s/${encodeURIComponent(id)}`
  return { attention: `${root}/attention`, room: `${root}/team`,
    requirement: (req: string) => `${root}/req/${encodeURIComponent(req)}`,
    run: (run: string) => `${root}/run/${encodeURIComponent(run)}` }
}

function resultMessage(reply: TeamReply, urls: ReturnType<typeof links>) {
  return text([clip(reply.text, 3000), reply.requirementId && `需求：${urls.requirement(reply.requirementId)}`,
    reply.runId && `运行：${urls.run(reply.runId)}`].filter(Boolean).join('\n'))
}

function draftIntent(message: string): { text: string; includeDiscussion: boolean } | undefined {
  const direct = /^建需求(?:[：:\s]+|$)([\s\S]*)$/.exec(message)
  if (direct) return { text: direct[1]!.trim(), includeDiscussion: false }
  const discussed = /^把刚(?:才)?讨论的(.*?)建成需求[。！!，,\s]*$/.exec(message)
  if (discussed) return { text: discussed[1]!.trim() || '团队讨论整理', includeDiscussion: true }
}

type ActiveAttention = { item: AttentionItem; revision: string }

async function activeAttention(stores: ProjectStores, items: AttentionItem[], onlyRequestId?: string): Promise<ActiveAttention[]> {
  const latest = new Map<string, AttentionItem>()
  for (const item of items) if (item.kind !== 'assumption') latest.set(JSON.stringify([item.runId, item.nodeId, item.kind === 'budget']), item)
  const result: ActiveAttention[] = []
  for (const item of latest.values()) {
    if (item.answeredAt || item.stale || (onlyRequestId !== undefined && item.requestId !== onlyRequestId)) continue
    const run = await stores.runs.get(item.runId)
    if (!run || run.kind === 'task' || run.requirementId !== item.requirementId || !['waiting_human', 'running'].includes(run.status)) continue
    const node = run.nodes[item.nodeId]
    if (item.kind !== 'budget' && node?.status !== 'waiting_human' && !(item.kind === 'retry' && node?.status === 'blocked')) continue
    const requirement = await stores.workspaces.getRequirement(item.requirementId)
    if (!requirement || requirement.status === 'archived') continue
    const [checked] = await withAttentionStaleness(stores, [{ ...item, boundTo: item.boundTo ?? node?.inputs }])
    if (checked!.stale) continue
    const revision = sha256(JSON.stringify([item.requestId, item.runId, item.nodeId, item.requirementId,
      item.createdAt, item.kind, item.form, item.ask, node?.attempts, node?.revision, checked!.boundTo]))
    result.push({ item, revision })
  }
  return result
}

async function attentionElements(stores: ProjectStores, scope: FeishuScope, urls: ReturnType<typeof links>, { item, revision }: ActiveAttention) {
  const description = div(`${item.requirementId} · ${item.nodeId}\n${clip(item.ask, 360)}`)
  if (item.form !== 'approve') return [description, actions(link('去 Web 回答', urls.attention))]
  const card = await feishuActionStore(stores.taktDir).approval(scope, item.requestId, revision)
  return [description, actions(button('批准', card.id, card.decisions.approve, 'primary'),
    button('拒绝', card.id, card.decisions.reject, 'danger'), link('查看运行', urls.run(item.runId)))]
}

/** 调用方只向当前绑定的群发送；无有效工作流审批时返回 undefined。 */
export async function feishuAttentionCard(stores: ProjectStores, bindingRevision: string, publicBaseUrl: string,
  requestId: string, chatId?: string): Promise<FeishuMessage | undefined> {
  if (!bindingRevision) return
  const scope = { spaceId: spaceId(stores), revision: bindingRevision, chatId }
  const [active] = await activeAttention(stores, await stores.attention.list(), requestId)
  if (active?.item.form !== 'approve') return
  return interactive('工作流审批', await attentionElements(stores, scope, links(publicBaseUrl, scope.spaceId), active))
}

/** 仅接收已经验签、核对当前群绑定并映射到空间成员的事件。返回消息的 content 由发送层编码为 JSON。 */
export async function handleFeishuEvent(stores: ProjectStores, memberId: string, event: FeishuEvent, ctx: FeishuActionContext): Promise<FeishuMessage> {
  const scope = { spaceId: spaceId(stores), chatId: event.chatId, revision: ctx.bindingRevision }
  const urls = links(ctx.publicBaseUrl, scope.spaceId)
  const by: TeamHuman = { type: 'human', id: memberId }
  const currentStores = async () => {
    await ctx.assertCurrentBinding?.()
    const live = await openProject(stores.projectDir)
    if (!scope.revision || !scope.chatId || live.projectDir !== stores.projectDir || spaceId(live) !== scope.spaceId ||
        memberId === 'web' || !live.config.members?.some(member => member.id === memberId && member.role !== 'viewer')) {
      throw new HttpError(403, '仅当前空间成员（member 或更高角色）可以使用群管家。')
    }
    return live
  }
  try {
    await currentStores()
    const room = teamRoomService(stores, ctx.options, { enqueueTeamJob, teamJobs, teamNodes }, currentStores, 'feishu')
    const cards = feishuActionStore(stores.taktDir)
    const requestId = `feishu:${sha256(JSON.stringify([scope, event.id]))}`
    if (event.kind === 'action') {
      const { card: cardId, token } = event.value
      const card = cardId && token ? await cards.read(cardId, scope) : undefined
      if (!card) return text('此卡片无效或群绑定已变更，请在当前群重新请求。')
      if (card.kind === 'draft') {
        const workflow = card.workflows.find(choice => choice.token === token)
        if (!workflow) return text('无效的工作流选项，请使用草稿上的按钮。')
        const { reply } = await room.submit(by, { mode: 'workflow', requestId, text: card.text, workflowId: workflow.id, includeDiscussion: false }, {
          operationKey: `feishu:draft:${cardId}`,
          displayText: `确认需求草稿「${clip(card.text, 120)}」，选择工作流「${workflow.title}」。`, discussion: card.discussion,
          beforeRecord: async () => {
            const live = await currentStores()
            if (!(await workflowStore(live).list({ record: false })).some(item => item.id === workflow.id)) {
              throw new HttpError(409, '此工作流已不在空间的可选列表中，请重新生成草稿。')
            }
          },
        })
        return resultMessage(reply, urls)
      }
      return await answerCard(card, token, requestId, by, currentStores, room, ctx.options, urls)
    }

    const message = event.text.trim().replace(/^@管家(?:[\s：:]+|$)/, '').trim()
    if (!message) return text('请告诉我你想讨论什么，或发送「建需求 …」「待办」。')
    if (message.length > 32_000) return text('消息不能超过 32000 个字符。')
    if (message === '待办') {
      const live = await currentStores()
      const pending = await activeAttention(live, await live.attention.list())
      if (!pending.length) return text(`当前没有可处理的工作流待办。\n${urls.attention}`)
      const elements = []
      for (const active of pending.slice(0, 5)) {
        elements.push(...await attentionElements(await currentStores(), scope, urls, active))
      }
      return interactive(`工作流待办（${pending.length}）`, [...elements, actions(link('在 Web 查看全部', urls.attention))])
    }
    const draft = draftIntent(message)
    if (!draft) return resultMessage((await room.submit(by, { mode: 'chat', requestId, text: message })).reply, urls)
    if (!draft.text) return text('请在「建需求」之后填写需求标题和说明。')

    const { id } = await room.record(by, requestId, { message }, message, async (live, id, history) => {
      const card = await cards.issue(id, scope, async () => {
        const workflows = (await workflowStore(live).list({ record: false })).slice(0, 6)
          .map(({ id, title }) => ({ id, title, token: randomUUID() }))
        await currentStores()
        return { kind: 'draft', text: draft.text, discussion: draft.includeDiscussion ? formatDiscussion(history) : '', workflows }
      })
      return { text: card.kind === 'draft' && card.workflows.length
        ? '需求草稿已保存，等待成员选择工作流并确认。' : '需求草稿已保存；空间尚无可选工作流，请在 Web 配置。' }
    })
    const card = await cards.read(id, scope)
    if (card?.kind !== 'draft') throw new Error('需求草稿卡片不存在')
    return interactive('需求草稿 · 选择工作流以确认启动', [div(clip(card.text, 420)),
      ...(card.discussion ? [div(`带入的团队讨论（节选）：\n${clip(card.discussion, 480)}`)] : []),
      ...card.workflows.map(choice => actions(button(`启动：${clip(choice.title, 50)}`, id, choice.token, 'primary'))),
      actions(link('打开团队会话', urls.room))])
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return text(error.message)
    throw error
  }
}

async function answerCard(card: Extract<FeishuCard, { kind: 'approval' }>, token: string | undefined,
  requestId: string, by: TeamHuman, currentStores: () => Promise<ProjectStores>,
  room: ReturnType<typeof teamRoomService>, options: M3Callbacks, urls: ReturnType<typeof links>) {
  const decision = token === card.decisions.approve ? 'approve' : token === card.decisions.reject ? 'reject' : undefined
  if (!decision) return text('无效的审批选项，请使用待办卡片上的按钮。')
  const operationKey = `feishu:approval:${sha256(JSON.stringify([card.scope.revision, card.requestId, card.itemRevision]))}`
  const validated = async (live: ProjectStores) => {
    const items = await live.attention.list()
    if (items.some(item => item.requestId === card.requestId && item.answeredAt)) throw new HttpError(409, '此待办已处理，不会重复提交。')
    const [active] = await activeAttention(live, items, card.requestId)
    if (active?.item.form !== 'approve' || active.revision !== card.itemRevision) {
      throw new HttpError(409, `待办状态或审批对象已变化，请在 Web 核对：${urls.attention}`)
    }
    return active.item
  }
  const outcome = (item: AttentionItem): TeamReply => ({ requirementId: item.requirementId, runId: item.runId,
    text: item.decision === 'approve' ? `待办 ${item.requestId} 已批准。` : item.decision === 'reject'
      ? `待办 ${item.requestId} 已拒绝。` : `待办 ${item.requestId} 已处理。` })
  const { reply } = await room.record(by, requestId, { operationKey },
    `在飞书${decision === 'approve' ? '批准' : '拒绝'}待办 ${card.requestId}。`, async (live, _id, _history, interrupted) => {
      const answered = async () => (await live.attention.list()).find(item => item.requestId === card.requestId && item.answeredAt)
      if (interrupted) {
        const item = await answered()
        return item ? outcome(item) : { text: `上次审批提交未完成，请在 Web 核对并处理：${urls.attention}` }
      }
      try {
        await validated(live)
        const item = await commandExecutor(options).executeAs(await currentStores(), by, 'attention.answer',
          { requestId: card.requestId, decision }, '飞书群人工处理待办') as AttentionItem
        return outcome(item)
      } catch (error) {
        const item = await answered()
        if (item) return outcome(item)
        if (error instanceof HttpError) return { text: error.message }
        throw error
      }
    }, { operationKey, beforeRecord: async () => { await validated(await currentStores()) } })
  return resultMessage(reply, urls)
}
