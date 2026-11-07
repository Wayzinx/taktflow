import type { KnowledgeSource } from '@taktflow/core'
import { markdownPages, rankMarkdown } from './markdown.js'

export function createWikiSource({ root }: { root: string }): KnowledgeSource {
  return {
    id: 'wiki',
    kind: 'wiki',
    intents: ['business'],
    describe: () =>
      `Wiki Markdown 知识库：${root}；先检索路径、标题、别名和摘要，再提取相关正文段落。`,
    query: async (query2) => rankMarkdown(await markdownPages(root), query2, 'wiki'),
  }
}
