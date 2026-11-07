import { resolve } from 'node:path'
import type { KnowledgeSource } from '@taktflow/core'
import { createGrepSource } from './grep.js'
import { createWikiSource } from './wiki.js'
import { createWorkspaceSource } from './workspace.js'
import { createGitHistorySource } from './git-history.js'
import { createCodeGraphSource, createDatabaseSource, createApiRegistrySource } from './stubs.js'

export { createGrepSource } from './grep.js'
export { createWikiSource } from './wiki.js'
export { createWorkspaceSource } from './workspace.js'
export { createGitHistorySource } from './git-history.js'
export { createCodeGraphSource, createDatabaseSource, createApiRegistrySource } from './stubs.js'
export { createKnowledgeRouter } from './router.js'

export function createDefaultSources(options: {
  projectDir: string
  taktDir: string
  wikiDir?: string
}): KnowledgeSource[] {
  const sources = [
    createGrepSource({ root: options.projectDir }),
    createWorkspaceSource({ taktDir: options.taktDir }),
    createGitHistorySource({ root: options.projectDir }),
    createCodeGraphSource(),
    createDatabaseSource(),
    createApiRegistrySource(),
  ]
  if (options.wikiDir !== undefined) {
    sources.push(createWikiSource({ root: resolve(options.projectDir, options.wikiDir) }))
  }
  return sources
}
export { createKnowledgeStore, inferKnowledgeIntent, type KnowledgeStoreOptions } from './store/index.js'
export { createSecretResolver } from './store/secrets.js'
export * from './kinds/index.js'
export { KnowledgeBlockedError, guardSql, maskRow } from './kinds/database.js'
