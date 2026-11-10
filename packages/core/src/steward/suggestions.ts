import type { StewardDeps } from './contracts.js'
export async function stewardSuggestions(
  deps: StewardDeps,
  page: string,
  spaceId?: string,
  id?: string,
): Promise<string[]> {
  const space = spaceId ? await deps.open(spaceId) : undefined
  const name = space?.name ?? '当前空间'
  // 建议都用人话；没配模型时规则降级也认"新建一个需求 / 新建项目空间"，会追问名字。
  if (page === 'spaces') return ['新建项目空间', '看进度和风险']
  if (page === 'workflows') return ['流水线适合什么需求？', '新建一条流水线']
  if (page === 'workflow')
    return [
      '每个阶段做什么？',
      '验收前加人工确认',
    ]
  if (page === 'knowledge') {
    const bases = (await space?.stores.kb?.list()) ?? []
    return bases.length
      ? ['检查检索效果']
      : ['从 docs/ 建知识库']
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
      ? ['评审换个模型']
      : [`检查${tabs[page.slice(9)] ?? '空间'}设置`]
  }
  if (page === 'eval') return ['哪些成绩退化了？']
  if (page === 'run') return ['进度和预算？']
  if (page === 'requirement' && id) {
    const req = await space?.stores.workspaces.getRequirement(id)
    const pending = (await space?.stores.attention.list({ requirementId: id, pending: true })) ?? []
    return [
      pending.length ? '卡在哪了？' : '进度怎么样？',
      '验收还差什么？',
    ]
  }
  if (page === 'requirements') return ['进度怎么样？', '新建一个需求']
  return ['进度怎么样？', '有什么风险？', '我有哪些待办？']
}
