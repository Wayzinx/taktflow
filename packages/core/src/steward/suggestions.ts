import type { StewardDeps } from './contracts.js'
export async function stewardSuggestions(
  deps: StewardDeps,
  page: string,
  spaceId?: string,
  id?: string,
): Promise<string[]> {
  const space = spaceId ? await deps.open(spaceId) : undefined
  const name = space?.name ?? '当前空间'
  // 没配模型时管家走规则降级，只认"新建空间 <名称>"这类句式；建议点开后预填在输入框，用户改名后发送。
  const online = Boolean(deps.chat)
  if (page === 'spaces') return [online ? '帮我新建一个项目空间' : '新建空间 我的项目', '帮我看看各空间的进度和风险']
  if (page === 'workflows') return [`帮我说明 ${name} 的每条流水线适合什么需求`, '帮我新建一条流水线']
  if (page === 'workflow')
    return [
      `帮我解释 ${id ?? '这条流水线'} 每个阶段做什么`,
      `帮我在 ${id ?? '这条流水线'} 的验收之前加一个人工确认节点`,
    ]
  if (page === 'knowledge') {
    const bases = (await space?.stores.kb?.list()) ?? []
    return bases.length
      ? [`帮我检查 ${bases.find((base) => base.id === id)?.name ?? bases[0]!.name} 的检索效果`]
      : ['帮我从 docs/ 建一个文档知识库']
  }
  if (page.startsWith('settings-')) {
    const tabs: Record<string, string> = {
      knowledge: '知识库',
      members: '成员',
      general: '常规',
      repos: '仓库',
      agents: '角色',
      roles: '角色',
      skills: '技能',
      models: '模型',
      steward: '管家',
      harnesses: '执行器',
      budget: '预算',
    }
    return page === 'settings-models'
      ? ['把评审节点都换成另一家模型']
      : [`帮我检查 ${name} 的${tabs[page.slice(9)] ?? '空间'}设置`]
  }
  if (page === 'eval') return [`帮我查看 ${name} 哪些节点的成绩退化了`]
  if (page === 'run') return [`帮我查看运行 ${id ?? ''} 的进度和预算`]
  if (page === 'requirement' && id) {
    const req = await space?.stores.workspaces.getRequirement(id)
    const pending = (await space?.stores.attention.list({ requirementId: id, pending: true })) ?? []
    return [
      pending.length ? `帮我看看 ${req?.id ?? id} 卡在哪` : `帮我查看 ${req?.title ?? id} 的进度`,
    ]
  }
  if (page === 'requirements') return [`帮我查看 ${name} 的需求进度`, online ? '帮我新建一个需求' : '新建需求 新需求']
  return [`帮我查看 ${name} 的进度`, `帮我查看 ${name} 的风险`, `帮我查看 ${name} 的待办`]
}
