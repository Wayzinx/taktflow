import { join } from 'node:path'
import type { KnowledgeSource } from '@taktflow/core'
import { directoryEntries, markdownPages, rankMarkdown } from './markdown.js'

export function createWorkspaceSource({ taktDir }: { taktDir: string }): KnowledgeSource {
  return {
    id: 'workspace',
    kind: 'workspace',
    intents: ['business', 'history'],
    describe: () => `过往需求：${taktDir}/workspaces；检索 spec、decisions、reports 中的 Markdown。`,
    query: async q => {
      const roots = await directoryEntries(taktDir)
      if (!roots.some(entry => entry.name === 'workspaces' && !entry.isSymbolicLink())) return []
      const root = join(taktDir, 'workspaces')
      const pages = []
      for (const requirement of await directoryEntries(root)) {
        if (!requirement.isDirectory()) continue
        const requirementDir = join(root, requirement.name)
        const entries = await directoryEntries(requirementDir)
        for (const directory of ['spec', 'decisions', 'reports']) {
          if (!entries.some(entry => entry.name === directory && !entry.isSymbolicLink())) continue
          pages.push(...await markdownPages(join(requirementDir, directory), root))
        }
      }
      return rankMarkdown(pages, q, 'workspace')
    },
  }
}
