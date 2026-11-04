import { resolve } from 'node:path'
import type { KnowledgeSource, ProjectStores } from '@taktflow/core'
import {
  createApiRegistrySource, createCodeGraphSource, createDatabaseSource, createDefaultSources,
  createGitHistorySource, createGrepSource, createWikiSource, createWorkspaceSource,
} from '@taktflow/knowledge'
import { UsageError } from './args.js'

export function knowledgeFromConfig(stores: ProjectStores): KnowledgeSource[] {
  if (stores.config.knowledge === undefined) return createDefaultSources({ projectDir: stores.projectDir, taktDir: stores.taktDir })
  return stores.config.knowledge.map(({ id, kind, options = {} }) => {
    const path = (key: string, fallback: string): string => {
      const value = options[key] ?? fallback
      if (typeof value !== 'string' || !value.trim()) throw new UsageError(`知识源 ${id} 的 ${key} 必须是非空路径`)
      return resolve(stores.projectDir, value)
    }
    const allowed = kind === 'grep' ? ['root', 'ignore'] : kind === 'workspace' ? ['taktDir'] : ['wiki', 'git-history'].includes(kind) ? ['root'] : []
    const unsupported = Object.keys(options).filter((key) => !allowed.includes(key))
    if (unsupported.length) throw new UsageError(`知识源 ${id} (${kind}) 不支持选项：${unsupported.join(', ')}；请检查 takt.config.json`)
    let source: KnowledgeSource
    switch (kind) {
      case 'grep': {
        const ignore = options.ignore
        if (ignore !== undefined && (!Array.isArray(ignore) || !ignore.every((value) => typeof value === 'string'))) throw new UsageError(`知识源 ${id} 的 ignore 必须是字符串数组`)
        source = createGrepSource({ root: path('root', stores.projectDir), ignore: ignore as string[] | undefined })
        break
      }
      case 'wiki': source = createWikiSource({ root: path('root', 'docs/wiki') }); break
      case 'git-history': source = createGitHistorySource({ root: path('root', stores.projectDir) }); break
      case 'workspace': source = createWorkspaceSource({ taktDir: path('taktDir', stores.taktDir) }); break
      case 'codegraph': source = createCodeGraphSource(); break
      case 'database': source = createDatabaseSource(); break
      case 'api-registry': source = createApiRegistrySource(); break
      default: throw new UsageError(`未知知识源 kind：${kind}（${id}）；请在 takt.config.json 使用 grep、wiki、workspace、git-history、codegraph、database 或 api-registry`)
    }
    return { ...source, id, query: async (query) => (await source.query(query)).map((hit) => ({ ...hit, sourceId: id })) }
  })
}
