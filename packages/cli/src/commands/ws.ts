import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { listArtifactHistory, markArtifactEdited, withdrawArtifact, withLock, type ArtifactKind } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { openStores } from '../project.js'

const KINDS = new Set<ArtifactKind>([
  'input', 'clarification', 'spec', 'design', 'contract', 'test-plan', 'case', 'task', 'script',
  'code-change', 'evidence', 'verdict', 'review', 'report', 'decision', 'knowledge', 'other',
])

/** 当前用户：在目标项目目录里读 git user.name（不是 CLI 调用方 cwd），其次 $USER。 */
export function currentUser(cwd?: string): string {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (name !== '') return name
  } catch {
    // 不在 git 仓库或没配置：退回环境变量
  }
  return process.env.USER ?? process.env.USERNAME ?? 'anonymous'
}

export async function runWsPut(
  project: string | undefined,
  id: string,
  path: string,
  file: string,
  options: { kind?: string; reason?: string; json: boolean },
): Promise<void> {
  const kind = (options.kind ?? 'input') as ArtifactKind
  if (!KINDS.has(kind)) throw new Error(`未知产物类型：${kind}（可选：${[...KINDS].join(', ')}）`)
  const stores = await openStores(project)
  if (!await stores.workspaces.getRequirement(id)) throw new Error(`需求不存在：${id}`)
  const content = file === '-' ? await readStdin() : await readFile(file)
  const author = { type: 'human' as const, id: currentUser(stores.projectDir) }
  const reason = options.reason ?? '人工写入'
  const result = await withLock(stores.projectDir, async () => {
    const record = (await stores.workspaces.listArtifacts(id)).find((item) => item.path === path)
    const ref = await stores.workspaces.writeArtifact({ ref: { workspace: id, path }, content, kind, author, reason })
    const staleNodes = ref.version === record?.versions.at(-1)?.version ? [] : await markArtifactEdited(stores, ref, author, reason)
    return { ...ref, staleNodes }
  })
  const printer = createPrinter(options.json)
  if (options.json) printer.data(result)
  else {
    printer.text(`${printer.colors.green('✔')} ${id}/${result.path} v${result.version}`)
    for (const node of result.staleNodes) printer.text(`  stale ${node.runId}/${node.nodeId}`)
  }
}

export async function runWsGet(
  project: string | undefined,
  id: string,
  path: string,
  options: { version?: number; json: boolean },
): Promise<void> {
  const stores = await openStores(project)
  const content = await stores.workspaces.readArtifact({ workspace: id, path, version: options.version })
  if (content === undefined) throw new Error(`产物不存在：${id}/${path}${options.version === undefined ? '' : ` v${options.version}`}`)
  const printer = createPrinter(options.json)
  if (options.json) {
    printer.data({ workspace: id, path, version: options.version, content: content.toString('base64'), encoding: 'base64' })
    return
  }
  // 原样输出字节，不补换行。
  process.stdout.write(content)
}

export async function runWsList(project: string | undefined, id: string, json: boolean): Promise<void> {
  const stores = await openStores(project)
  if (!await stores.workspaces.getRequirement(id)) throw new Error(`需求不存在：${id}`)
  const artifacts = await stores.workspaces.listArtifacts(id)
  const printer = createPrinter(json)
  if (json) {
    printer.data(artifacts)
    return
  }
  if (artifacts.length === 0) {
    printer.text(printer.colors.dim('公共存放区还是空的。'))
    return
  }
  for (const artifact of artifacts) {
    const latest = artifact.versions.at(-1)
    printer.text(`${printer.colors.cyan(artifact.path.padEnd(36))} ${artifact.kind.padEnd(14)} v${latest?.version ?? 0} ${printer.colors.dim(latest?.createdAt ?? '')}`)
  }
}

export async function runWsLog(project: string | undefined, id: string, path: string, json: boolean): Promise<void> {
  const stores = await openStores(project)
  const record = (await listArtifactHistory(stores, id)).find((artifact) => artifact.path === path)
  if (!record) throw new Error(`产物不存在：${id}/${path}`)
  const printer = createPrinter(json)
  if (json) {
    printer.data(record.versions)
    return
  }
  for (const version of record.versions) {
    const author = version.author.type === 'human' ? `human:${version.author.id}`
      : version.author.type === 'agent' ? `agent:${version.author.role}` : version.author.id
    const producedBy = version.producedBy === undefined ? '' : ` ← ${version.producedBy.runId}/${version.producedBy.nodeId}`
    const reason = version.reason === undefined ? '' : `  ${version.reason}`
    printer.text(`v${String(version.version).padStart(2)} ${version.createdAt} ${printer.colors.cyan(author)}${producedBy}${version.sha256 === '' ? '（已撤回）' : ''}${reason}`)
  }
}

export async function runWsWithdraw(project: string | undefined, path: string, options: { req?: string; reason?: string; json: boolean }): Promise<void> {
  if (!options.reason?.trim()) throw new Error('撤回产物需要 --reason <原因>')
  const stores = await openStores(project)
  const requirements = await stores.workspaces.listRequirements()
  const id = options.req ?? (requirements.length === 1 ? requirements[0]!.id : undefined)
  if (!id) throw new Error('无法唯一确定需求，请指定 --req <id>')
  if (!requirements.some(requirement => requirement.id === id)) throw new Error(`需求不存在：${id}`)
  const author = { type: 'human' as const, id: currentUser(stores.projectDir) }
  const reason = options.reason
  const result = await withLock(stores.projectDir, async () => {
    const record = (await listArtifactHistory(stores, id)).find(item => item.path === path)
    const ref = (await withdrawArtifact(stores, { ref: { workspace: id, path }, author, reason }))!
    const staleNodes = ref.version === record?.versions.at(-1)?.version ? [] : await markArtifactEdited(stores, ref, author, reason)
    return { ...ref, staleNodes }
  })
  const printer = createPrinter(options.json)
  if (options.json) printer.data(result)
  else {
    printer.text(`${printer.colors.green('✔')} 已撤回 ${id}/${path} v${result.version}`)
    for (const node of result.staleNodes) printer.text(`  stale ${node.runId}/${node.nodeId}`)
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks)
}
