import { sha256 } from '../util/hash.js'
import type { StewardContextRef, StewardPrefs, StewardFindResult, StewardEntityView } from '../api.js'
import { entityQuery } from './find.js'
import type { StewardToolResult } from './tools.js'
export type OfflineCall = (
  name: string,
  input: Record<string, unknown>,
) => Promise<StewardToolResult & { numbers?: number[] }>
export async function offlineAnswer(
  text: string,
  context: StewardContextRef[],
  prefs: StewardPrefs,
  call: OfflineCall,
): Promise<string> {
  const available = await call('list_spaces', {})
  const named = (available.data as Array<{ id: string; name: string }>).filter((space) =>
    [space.id, space.name].some(
      (value) =>
        value &&
        (/[\u3400-\u9fff]/.test(value)
          ? text.includes(value)
          : text.split(/[^\w.-]+/).includes(value)),
    ),
  )
  const current =
    (named.length === 1 ? named[0]!.id : undefined) ??
    context.find((ref) => ref.spaceId)?.spaceId ??
    context.find((ref) => ref.type === 'space')?.id ??
    prefs.defaultSpace
  const req = context.find((ref) => ref.type === 'requirement')
  const suffix = (result: StewardToolResult & { numbers?: number[] }) =>
    (result.numbers ?? []).map((n) => `[${n}]`).join('')
  const createReq = text.match(
    /(?:新建|建个|创建)\s*需求\s*[:：]?\s*(.+)|(?:create|new)\s+(?:a\s+)?requirement\s*[:：]?\s*(.+)/i,
  )
  if (createReq) {
    if (!current) return '要把需求建在哪个空间？'
    const title = (createReq[1] ?? createReq[2])!.trim()
    const result = await call('propose', {
      title: `新建需求 ${title}`,
      summary: '按用户要求新建草稿需求',
      steps: [
        {
          kind: 'command',
          spaceId: current,
          commandId: 'requirement.create',
          input: { title, start: false },
        },
      ],
    })
    const status = (result.data as { status: string }).status
    return `${status === 'applied' ? '需求已创建，可撤销' : status === 'failed' ? '需求创建失败，请查看提案执行结果' : '已生成新建需求提案，请预览后批准'}${suffix(result)}。`
  }
  const createSpace = text.match(
    /(?:新建|建个|创建)\s*空间\s*[:：]?\s*(.+)|(?:create|new)\s+(?:a\s+)?space\s*[:：]?\s*(.+)/i,
  )
  if (createSpace) {
    const name = (createSpace[1] ?? createSpace[2])!.trim(),
      id =
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '') || `space-${sha256(name).slice(0, 8)}`
    const result = await call('propose', {
      title: `新建空间 ${name}`,
      summary: '按用户要求使用标准模板创建空间',
      steps: [
        { kind: 'command', commandId: 'space.create', input: { id, name, template: 'standard' } },
      ],
    })
    return `已生成新建空间提案，请预览后批准${suffix(result)}。`
  }
  const entityAnswer = await offlineEntity(text, context, named, current, call, suffix)
  if (entityAnswer !== undefined) return entityAnswer
  if (/(风险|risk|待办|todo|attention|进度|进展|progress|status|状态|卡在哪|处理什么|我要处理|验收还差)/i.test(text)) {
    const listed =
      !current && !prefs.watchedSpaces?.length ? await call('list_spaces', {}) : undefined
    const ids = current
      ? [current]
      : prefs.watchedSpaces?.length
        ? prefs.watchedSpaces
        : (listed!.data as Array<{ id: string }>)
    const spaces = ids.map((id) => (typeof id === 'string' ? id : id.id))
    if (!spaces.length) return `还没有可查询的空间${listed ? suffix(listed) : ''}。请先新建空间。`
    const answers: string[] = []
    for (const spaceId of spaces) {
      if (/风险|risk/i.test(text)) {
        const result = await call('show', { preset: [{ preset: 'risks', spaceId }] })
        answers.push(`风险已整理成可视化卡片${suffix(result)}。`)
      } else if (/待办|todo|attention|处理什么|我要处理/i.test(text)) {
        const result = await call('show', { preset: [{ preset: 'attention', spaceId }] })
        answers.push(`待办已整理成可勾选清单${suffix(result)}。`)
      } else if (req) {
        const result = await call('show', {
          preset: [{ preset: 'requirement_progress', spaceId, requirementId: req.id }],
        })
        answers.push(`这条需求的进度已整理成阶段视图${suffix(result)}。`)
      } else {
        const result = await call('show', { preset: [{ preset: 'space_progress', spaceId }] })
        answers.push(`当前进度已整理成阶段视图${suffix(result)}。`)
      }
    }
    return answers.join('\n')
  }
  return `需要先配置管家模型。请打开[管家设置](${current ? `/s/${encodeURIComponent(current)}/settings?tab=steward` : '/solo?drawer=settings'})。`
}

async function offlineEntity(
  text: string,
  context: StewardContextRef[],
  named: Array<{ id: string; name: string }>,
  current: string | undefined,
  call: OfflineCall,
  suffix: (result: Awaited<ReturnType<OfflineCall>>) => string,
): Promise<string | undefined> {
  const attention = /等我|待办|审批|要我决定|todo|attention/i.test(text)
  const dag = /运行|流程图|画布|dag|节点图|run-/i.test(text)
  const stages = /阶段/.test(text)
  const node = /节点/.test(text) && !/节点图/.test(text)
  let queryText = text
  for (const space of named) for (const value of [space.id, space.name]) queryText = queryText.replaceAll(value, '')
  const query = entityQuery(queryText)
  const scope = named.length === 1 ? named[0]!.id : context.find(ref => ref.type === 'space')?.id
  let ref = context.find(item => item.type === 'node') ?? context.find(item => item.type === 'run') ?? context.find(item => item.type === 'requirement')
  const requirement = ref?.type === 'requirement' && node ? ref : undefined
  if (requirement) ref = undefined
  if (!ref && attention && !query && current) ref = { type: 'space', id: current, spaceId: current }
  if (!ref && query) {
    const types = node ? ['node'] : /run-[\w.-]+/i.test(text) ? ['run'] : ['requirement', 'run', 'node']
    const findSpace = requirement?.spaceId ?? scope
    const found = await call('find', { q: requirement ? `${requirement.id} ${queryText}` : queryText, types, ...(findSpace ? { spaceId: findSpace } : {}) })
    const result = found.data as StewardFindResult
    if (result.items?.length) {
      if (result.ambiguous) {
        await call('show', { blocks: [{ type: 'pick', items: result.items.slice(0, 5).map(item => ({ ref: item.ref, why: item.why })) }] })
        return '找到几个，你说的是哪一个？'
      }
      ref = result.items[0]!.ref
    }
  }
  if (!ref) return undefined
  let view: StewardEntityView = ref.type === 'node' ? 'node' : ref.type === 'run' ? 'dag' : attention ? 'attention' : stages ? 'stages' : 'card'
  if (ref.type === 'requirement' && dag && !attention && !stages) {
    // 查询最近运行前必须唯一确定空间，不能擅自套用默认空间。
    let spaceId = ref.spaceId
    if (!spaceId) {
      const found = (await call('find', { q: ref.id, types: ['requirement'] })).data as StewardFindResult
      if (found.ambiguous) {
        await call('show', { blocks: [{ type: 'pick', items: found.items.slice(0, 5) }] })
        return '找到几个，你说的是哪一个？'
      }
      spaceId = found.items[0]?.ref.spaceId
      if (!spaceId) return '没有找到可查看的需求，请重新选择需求。'
    }
    const status = await call('requirement_status', { spaceId, requirementId: ref.id })
    const run = (status.data as { latestRun?: { runId: string } }).latestRun
    if (!run) return `${ref.id} 还没开始运行${suffix(status)}。`
    ref = { type: 'run', spaceId, id: run.runId }; view = 'dag'
  }
  const result = await call('show', { blocks: [{ type: 'entity', view, ref }] })
  const content = (result.data as { content?: string[] }).content?.[0]
  return content ? `${content}${suffix(result)}。` : '没有找到可查看的对象，请重新选择引用。'
}
