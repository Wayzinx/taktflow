import { agent, defineWorkflow, planner, review } from '../dsl.js'
export function knowledgeWikiWorkflow() {
  return defineWorkflow({ id: 'kb-wiki-build', title: '生成知识 Wiki 提案', version: '1', stages: [], nodes: [
    planner({ id: 'plan', title: '按目录或模块拆分', role: 'wiki-writer', maxItems: 50, allowedRoles: ['wiki-writer'],
      prompt: ctx => `从代码生成 Wiki，只读源码。仓库、范围和粒度：${JSON.stringify(ctx.args)}。每个模块一个 PlannedItem，用安全的英文短横线 key。`,
      expand: item => [agent({ id: 'write', title: item.title, role: 'wiki-writer', prompt: ctx => `仓库和范围：${JSON.stringify(ctx.args)}。阅读模块 ${JSON.stringify(item)}，生成 generated/${item.key}.md。记录 sources 和 verifiedAt；解释模块职责、流程和设计原因；不改源码。`, outputs: [{ path: `generated/${item.key}.md`, kind: 'knowledge' }] })] }),
    agent({ id: 'index', title: '生成 Wiki 导航', role: 'wiki-writer', needs: ['plan'], inputs: [{ path: 'generated/*.md' }], outputs: [{ path: 'generated/index.md', kind: 'knowledge' }], prompt: '阅读 generated/*.md，生成 generated/index.md，使用相对链接，包含模块摘要和别名。不修改模块页。' }),
    review({ id: 'review', title: '独立评审 Wiki', needs: ['index'], target: ['generated/*.md'], author: { role: 'wiki-writer' }, reviewers: [{ role: 'reviewer' }], maxRounds: 2, onExhausted: 'fail' }),
  ] })
}
