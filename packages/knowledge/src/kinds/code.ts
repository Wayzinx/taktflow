import type { KnowledgeKind } from '@taktflow/core'
import { createGrepSource } from '../grep.js'
import { createCodeGraphSource } from '../stubs.js'
import { repositoryPath, safePath } from '../store/files.js'
export const codeKind: KnowledgeKind = {
  kind: 'code',
  title: '代码',
  summary: '精确符号和代码定位',
  intents: ['symbol', 'impact'],
  needsBuild: false,
  configSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      ignore: { type: 'array', items: { type: 'string' } },
      repos: { type: 'array', items: { type: 'string' } },
    },
  },
  async test() {
    return { ok: true, message: '代码搜索无需构建；影响面 CodeGraph 尚未接入' }
  },
  async query(kb, query2, ctx) {
    if (query2.intent === 'impact') return createCodeGraphSource().query(query2)
    const repos = kb.config.repos as string[] | undefined
    if (!repos?.length)
      return createGrepSource({
        root: await safePath(ctx.stores.projectDir, String(kb.config.path ?? '.')),
        ignore: kb.config.ignore as string[] | undefined,
      }).query(query2)
    const results = await Promise.all(
      repos.map(async (id) => {
        const repo = ctx.stores.config.repos?.find((record) => record.id === id)
        if (!repo) throw new Error('仓库未绑定，请检查 repos')
        const root = await repositoryPath(ctx.stores, repo.id)
        return (await createGrepSource({ root }).query(query2)).map((hit) => ({
          ...hit,
          ref: `${id}/${hit.ref}`,
        }))
      }),
    )
    return results.flat()
  },
}
