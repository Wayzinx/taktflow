import { sha256 } from '../util/hash.js'
import type { StewardContextRef, StewardPrefs } from '../api.js'
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
  if (/风险|risk|待办|todo|attention|进度|progress|status|卡在哪/i.test(text)) {
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
        const result = await call('list_risks', { spaceId }),
          risks = result.data as Array<{ title: string }>
        answers.push(
          `${spaceId} 有 ${risks.length} 条风险${risks.length ? `：${risks.map((r) => r.title).join('、')}` : ''}。${suffix(result)}`,
        )
      } else if (/待办|todo|attention/i.test(text)) {
        const result = await call('list_attention', { spaceId }),
          items = result.data as Array<{ ask: string }>
        answers.push(
          `${spaceId} 有 ${items.length} 条待办${items.length ? `：${items.map((r) => r.ask).join('；')}` : ''}。${suffix(result)}`,
        )
      } else if (req) {
        const result = await call('requirement_status', { spaceId, requirementId: req.id }),
          data = result.data as {
            requirement: { title: string; status: string; stage?: string }
            attention: unknown[]
          }
        answers.push(
          `${data.requirement.title}：状态 ${data.requirement.status}，阶段 ${data.requirement.stage ?? '未开始'}，待办 ${data.attention.length} 条。${suffix(result)}`,
        )
      } else {
        const result = await call('space_overview', { spaceId }),
          data = result.data as {
            requirements: Array<{ status: string }>
            runs: Array<{ status: string }>
            attention: unknown[]
          }
        answers.push(
          `${spaceId} 有 ${data.requirements.length} 条需求，其中 ${data.requirements.filter((r) => r.status === 'delivered').length} 条已交付，${data.runs.filter((r) => r.status === 'running').length} 个运行正在执行，${data.attention.length} 条待办。${suffix(result)}`,
        )
      }
    }
    return answers.join('\n')
  }
  return `需要先配置管家模型。请打开[管家设置](${current ? `/s/${encodeURIComponent(current)}/settings?tab=steward` : '/steward?settings=1'})。`
}
