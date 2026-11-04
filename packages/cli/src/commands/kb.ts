import type { KnowledgeIntent, KnowledgeQuery } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { openStores } from '../project.js'
import { UsageError } from '../args.js'

const INTENTS = new Set<KnowledgeIntent>(['fact', 'symbol', 'impact', 'business', 'history', 'schema'])

export async function runKbQuery(project: string | undefined, text: string, intent: string | undefined, json: boolean): Promise<void> {
  let parsed: KnowledgeIntent | undefined
  if (intent !== undefined) {
    if (!INTENTS.has(intent as KnowledgeIntent)) throw new UsageError(`--intent 必须是以下之一：${[...INTENTS].join(', ')}`)
    parsed = intent as KnowledgeIntent
  }
  const stores = await openStores(project)
  const printer = createPrinter(json)
  const wikiRoot = stores.config.knowledge?.find((source) => source.kind === 'wiki')?.options?.root
  const { createDefaultSources, createKnowledgeRouter } = await import('@taktflow/knowledge')
  const sources = createDefaultSources({
    projectDir: stores.projectDir,
    taktDir: stores.taktDir,
    ...(typeof wikiRoot === 'string' ? { wikiDir: wikiRoot } : {}),
  })
  const query: KnowledgeQuery = parsed === undefined ? { text } : { text, intent: parsed }
  const { hits } = await createKnowledgeRouter(sources).query(query)
  if (json) {
    printer.data(hits)
    return
  }
  if (hits.length === 0) {
    printer.text(printer.colors.dim('没有命中。'))
    return
  }
  for (const hit of hits) {
    const level = hit.evidenceLevel === undefined ? '' : printer.colors.dim(` [${hit.evidenceLevel}]`)
    printer.text(`${printer.colors.cyan(hit.ref)}${level}  ${hit.title}`)
    printer.text(`  ${hit.snippet.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
}
