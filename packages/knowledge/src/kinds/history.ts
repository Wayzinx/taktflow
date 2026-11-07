import type { KnowledgeKind } from '@taktflow/core'
import { createGitHistorySource } from '../git-history.js'
import { createWorkspaceSource } from '../workspace.js'
import { createWikiSource } from '../wiki.js'
import { safePath } from '../store/files.js'
export const historyKind: KnowledgeKind = {
  kind: 'history',
  title: '历史',
  summary: '提交原因和过往需求',
  intents: ['history', 'business'],
  needsBuild: false,
  configSchema: {
    type: 'object',
    properties: {
      workspacePath: { type: 'string' },
      path: { type: 'string' },
      source: { type: 'string', enum: ['git-history', 'workspace', 'both'] },
    },
  },
  async test() {
    return { ok: true, message: '历史检索无需构建' }
  },
  async query(kb, query2, ctx) {
    const root = await safePath(ctx.stores.projectDir, String(kb.config.path ?? '.'))
    const sources = [
      kb.config.source !== 'workspace' ? createGitHistorySource({ root }) : undefined,
      kb.config.source !== 'git-history'
        ? createWorkspaceSource({
            taktDir: kb.config.workspacePath
              ? await safePath(ctx.stores.projectDir, String(kb.config.workspacePath))
              : ctx.stores.taktDir,
          })
        : undefined,
    ].filter((total) => !!total)
    const hits = (await Promise.all(sources.map((total2) => total2.query(query2)))).flat()
    if (kb.config.source !== 'git-history') {
      const requirements = await ctx.stores.workspaces.listRequirements()
      for (const requirement of requirements)
        hits.push(
          ...(
            await createWikiSource({ root: ctx.stores.workspaces.dir(requirement.id) }).query(
              query2,
            )
          ).map((hit) => ({ ...hit, ref: `${requirement.id}/${hit.ref}` })),
        )
    }
    return [...new Map(hits.map((hit2) => [hit2.ref, hit2])).values()]
  },
}
