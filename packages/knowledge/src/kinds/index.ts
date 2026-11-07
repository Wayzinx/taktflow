import { ragKind } from './rag.js'
import { createWikiKind } from './llm-wiki.js'
import { databaseKind } from './database.js'
import { apiKind } from './api.js'
import { codeKind } from './code.js'
import { historyKind } from './history.js'
export const builtinKinds = [
  ragKind,
  createWikiKind(),
  databaseKind,
  apiKind,
  codeKind,
  historyKind,
]
export { ragKind, createWikiKind, databaseKind, apiKind, codeKind, historyKind }
