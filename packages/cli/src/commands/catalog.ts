import type { HarnessInfo, ModelInfo } from '@taktflow/core'
import { runtimeCatalog, runtimeHarnesses, runtimeModels, redactRuntime } from '../catalog.js'
import { loadRuntime } from '../project.js'
import { validateRuntime } from '../runtime-validation.js'
import { createPrinter, type Printer } from '../output.js'

function harnessTable(printer: Printer, rows: HarnessInfo[]): void {
  printer.text('id\tsource\tavailable\treason\tcapabilities\troles')
  for (const row of rows) printer.text([
    row.id, row.source, String(row.available), row.reason?.replace(/\s+/g, ' ') ?? '-',
    Object.entries(row.capabilities).map(([key, value]) => `${key}=${value}`).join(',') || '-', row.roles.join(',') || '-',
  ].join('\t'))
}

function modelTable(printer: Printer, rows: ModelInfo[]): void {
  printer.text('alias\tprovider\tprotocol\tid\tcontextWindow\tprice(input/output)\tkeyPresent')
  for (const row of rows) printer.text([
    row.alias, row.provider, row.protocol, row.id, row.contextWindow ?? '-',
    row.price ? `${row.price.input}/${row.price.output}` : '-', String(row.keyPresent),
  ].join('\t'))
}

export async function runCatalog(project: string | undefined, kind: 'harness' | 'models', json: boolean): Promise<void> {
  const context = await loadRuntime(project)
  validateRuntime(context)
  const printer = createPrinter(json)
  if (kind === 'harness') {
    const rows = await runtimeHarnesses(context)
    if (json) printer.data(rows)
    else harnessTable(printer, rows)
  } else {
    const rows = runtimeModels(context)
    if (json) printer.data(rows)
    else modelTable(printer, rows)
  }
}

export async function runDoctor(project: string | undefined, json: boolean): Promise<number> {
  const printer = createPrinter(json)
  const checks: Array<{ id: string; ok: boolean; reason?: string }> = [
    { id: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, reason: `Node ${process.versions.node}（需要 >=20）` },
  ]
  let catalog: Awaited<ReturnType<typeof runtimeCatalog>> = { harnesses: [], models: [] }
  let plugins: string[] = []
  try {
    const context = await loadRuntime(project)
    plugins = context.plugins.names
    try {
      validateRuntime(context)
      checks.push({ id: 'config', ok: true })
    } catch (error) {
      checks.push({ id: 'config', ok: false, reason: redactRuntime(context, error instanceof Error ? error.message : String(error)) })
    }
    checks.push({ id: 'plugins', ok: true })
    for (const [id, provider] of Object.entries(context.stores.config.providers ?? {})) {
      const missing = provider.apiKeyEnv && !process.env[provider.apiKeyEnv]?.trim()
      checks.push({ id: `provider:${id}`, ok: !missing, ...(missing ? { reason: `缺少环境变量 ${provider.apiKeyEnv}` } : {}) })
    }
    catalog = await runtimeCatalog(context)
  } catch (error) {
    checks.push({ id: 'config/plugins', ok: false, reason: error instanceof Error ? error.message : String(error) })
  }
  const ok = checks.every((check) => check.ok)
  if (json) printer.data({ ok, checks, plugins, ...catalog })
  else {
    for (const check of checks) printer.text(`${check.ok ? '✔' : '✘'} ${check.id}${check.reason ? `: ${check.reason}` : ''}`)
    printer.text(`plugins: ${plugins.join(', ') || '无'}`)
    harnessTable(printer, catalog.harnesses)
    modelTable(printer, catalog.models)
  }
  return ok ? 0 : 1
}
