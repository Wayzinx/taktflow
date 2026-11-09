import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { assertNoSymlinks, writeFileAtomic } from '../store/fs-utils.js'
import { sha256 } from '../util/hash.js'
import { normalizeWorkspaceQaScript } from './qa-command.js'

const execute = promisify(execFile)
const EXECUTIONS_ROOT = 'evidence/executions'
const MAX_ASSET_FILES = 512
const MAX_ASSET_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_FILES = 2_000
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

export interface ExecutionAssetFile {
  /** 相对空间根的 POSIX 路径。 */
  path: string
  bytes: number
  sha256: string
}

/** 入口脚本所在目录树的确定性快照；路径、字节数和内容哈希都参与 digest。 */
export interface ExecutionAssetSnapshot {
  entry: string
  directory: string
  scope: 'directory' | 'entry'
  digest: string
  files: ExecutionAssetFile[]
}

export interface ExecutionAssetDiff {
  before: string
  after: string
  changed: boolean
  added: string[]
  removed: string[]
  modified: string[]
  error?: string
}

/** 只记录可安全复核的 Git 元数据；不落原始 status 文本或环境变量。 */
export interface ExecutionGitSnapshot {
  revision?: string
  branch?: string
  statusDigest?: string
  dirty?: boolean
  baselineRevision?: string
  error?: string
}

export interface ExecutionArchiveFile {
  path: string
  archivePath: string
  bytes: number
  sha256: string
}

export interface ExecutionArchiveResult {
  directory: string
  files: ExecutionArchiveFile[]
  cases: Array<{ id: string; status: string; evidence?: string }>
  missing: string[]
  error?: string
}

export interface ExecutionReceiptRef {
  path: string
  sha256: string
  bytes: number
}

export interface ExecutionReceiptRecord {
  path: string
  sha256: string
  receipt: Record<string, unknown>
}

export interface ExecutionReceiptReadResult {
  receipts: ExecutionReceiptRecord[]
  errors: Array<{ path: string; error: string }>
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function posix(value: string): string {
  return value.split(path.sep).join('/')
}

function relativeWithin(root: string, target: string): string | undefined {
  const relative = path.relative(root, target)
  // 与根相等时返回空串（合法：入口位于空间根，目录就是根）；只拒绝越界。
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return posix(relative)
}

function safeSegment(value: string, fallback: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_').slice(0, 80)
  return safe === '' ? fallback : safe
}

/** 相对路径必须是单段安全的 POSIX 相对路径，不能逃逸或带符号链接。 */
function assertRelative(value: string, label: string): string {
  const normalized = posix(value).replace(/^\.\//, '')
  if (normalized === '' || normalized === '.' || path.posix.isAbsolute(normalized)) {
    throw new Error(`${label} 必须是相对路径：${value}`)
  }
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} 不能包含空段、. 或 ..：${value}`)
  }
  return normalized
}

function assertExecutionDir(value: string): string {
  const normalized = assertRelative(value, '执行证据目录')
  if (!normalized.startsWith(`${EXECUTIONS_ROOT}/`)) {
    throw new Error(`执行证据必须位于当前需求 ${EXECUTIONS_ROOT}/ 下：${value}`)
  }
  return normalized
}

export function executionEvidenceDir(runId: string, nodeId: string, executionId: string): string {
  return `${EXECUTIONS_ROOT}/${safeSegment(runId, 'run')}/${safeSegment(nodeId, 'node')}/${safeSegment(executionId, 'execution')}`
}

export function newExecutionId(iteration?: number): string {
  return `${iteration ?? 1}-${randomUUID()}`
}

async function walkFiles(
  root: string,
  relativeDirectory: string,
  limit: { files: number; bytes: number },
): Promise<ExecutionAssetFile[]> {
  const files: ExecutionAssetFile[] = []
  let bytes = 0
  const walk = async (directory: string): Promise<void> => {
    const absolute = path.join(root, directory)
    const entries = await readdir(absolute, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relative = directory === '' ? entry.name : `${directory}/${entry.name}`
      const absoluteEntry = path.join(root, relative)
      const info = await lstat(absoluteEntry)
      if (info.isSymbolicLink()) throw new Error(`测试资产树不能包含符号链接：${relative}`)
      if (info.isDirectory()) {
        await walk(relative)
        continue
      }
      if (!info.isFile()) continue
      if (files.length >= limit.files) throw new Error(`测试资产树文件数超过上限 ${limit.files}`)
      const content = await readFile(absoluteEntry)
      bytes += content.byteLength
      if (bytes > limit.bytes) throw new Error(`测试资产树字节数超过上限 ${limit.bytes}`)
      files.push({ path: relative, bytes: content.byteLength, sha256: sha256(content) })
    }
  }
  await walk(relativeDirectory)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * 快照入口脚本所在目录的全部普通文件，供执行前后比较。
 *
 * 入口必须是空间根内单个相对脚本；入口位于空间根时只快照入口自身，避免
 * 把整个空间（含其它需求）纳入读取范围。符号链接、越界路径和超限资产树
 * 都明确失败，不猜测。
 */
export async function snapshotExecutionAssets(rootInput: string, entryInput: string): Promise<ExecutionAssetSnapshot> {
  const root = await realpath(rootInput)
  const absoluteEntry = path.resolve(root, entryInput)
  const relativeEntry = relativeWithin(root, absoluteEntry)
  if (relativeEntry === undefined || relativeEntry === '') throw new Error(`入口脚本必须位于空间根内：${entryInput}`)
  const entry = normalizeWorkspaceQaScript(relativeEntry)
  if (entry === undefined) throw new Error(`入口脚本必须是空间根内单个相对路径：${entryInput}`)
  await assertNoSymlinks(root, absoluteEntry)
  const info = await lstat(absoluteEntry)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`入口脚本不是普通文件：${entry}`)
  const directory = relativeWithin(root, path.dirname(absoluteEntry))
  if (directory === undefined) throw new Error(`入口脚本目录必须位于空间根内：${entry}`)
  let files: ExecutionAssetFile[]
  let scope: 'directory' | 'entry'
  if (directory === '') {
    const content = await readFile(absoluteEntry)
    files = [{ path: entry, bytes: content.byteLength, sha256: sha256(content) }]
    scope = 'entry'
  } else {
    files = await walkFiles(root, directory, { files: MAX_ASSET_FILES, bytes: MAX_ASSET_BYTES })
    scope = 'directory'
  }
  return {
    entry,
    directory: directory === '' ? '.' : directory,
    scope,
    digest: sha256(JSON.stringify(files)),
    files,
  }
}

export function diffExecutionAssets(before: ExecutionAssetSnapshot, after: ExecutionAssetSnapshot): ExecutionAssetDiff {
  const beforeMap = new Map(before.files.map((file) => [file.path, file.sha256]))
  const afterMap = new Map(after.files.map((file) => [file.path, file.sha256]))
  const added = [...afterMap.keys()].filter((file) => !beforeMap.has(file)).sort()
  const removed = [...beforeMap.keys()].filter((file) => !afterMap.has(file)).sort()
  const modified = [...beforeMap.entries()]
    .filter(([file, hash]) => afterMap.has(file) && afterMap.get(file) !== hash)
    .map(([file]) => file)
    .sort()
  return {
    before: before.digest,
    after: after.digest,
    changed: added.length > 0 || removed.length > 0 || modified.length > 0 || before.digest !== after.digest,
    added,
    removed,
    modified,
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout.trim()
}

/** 采集实际执行 cwd 的 Git 身份；失败时返回 error，不阻断业务结果。 */
export async function captureGitSnapshot(cwd: string, baselineRevision?: string): Promise<ExecutionGitSnapshot> {
  const base = baselineRevision === undefined || baselineRevision === '' ? {} : { baselineRevision }
  try {
    const [revision, branch, status] = await Promise.all([
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['status', '--porcelain=v1']),
    ])
    return {
      revision,
      branch,
      statusDigest: sha256(status),
      dirty: status !== '',
      ...base,
    }
  } catch (error) {
    return { ...base, error: errorMessage(error) }
  }
}

async function walkEvidenceFiles(root: string, relativeDirectory: string): Promise<string[]> {
  const files: string[] = []
  let bytes = 0
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`
      if (relative.startsWith(`${EXECUTIONS_ROOT}/`)) continue
      const absolute = path.join(root, relative)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`证据归档不能包含符号链接：${relative}`)
      if (info.isDirectory()) {
        await walk(relative)
        continue
      }
      if (!info.isFile()) continue
      if (files.length >= MAX_ARCHIVE_FILES) throw new Error(`证据归档文件数超过上限 ${MAX_ARCHIVE_FILES}`)
      const content = await readFile(absolute)
      bytes += content.byteLength
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error(`证据归档字节数超过上限 ${MAX_ARCHIVE_BYTES}`)
      files.push(relative)
    }
  }
  await walk(relativeDirectory)
  return files.sort()
}

async function existingFiles(root: string, relative: string, missing: string[]): Promise<string[]> {
  const normalized = assertRelative(relative, '证据路径')
  if (normalized.startsWith(`${EXECUTIONS_ROOT}/`)) return []
  const absolute = path.join(root, normalized)
  try {
    await assertNoSymlinks(root, absolute)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`证据路径不能是符号链接：${normalized}`)
    if (info.isDirectory()) return await walkEvidenceFiles(root, normalized)
    return info.isFile() ? [normalized] : []
  } catch (error) {
    if (isEnoent(error)) {
      missing.push(normalized)
      return []
    }
    throw error
  }
}

async function writeImmutable(root: string, relative: string, content: Buffer): Promise<{ bytes: number; sha256: string }> {
  const normalized = assertRelative(relative, '归档目标')
  const absolute = path.join(root, normalized)
  await assertNoSymlinks(root, absolute)
  const hash = sha256(content)
  try {
    const existing = await readFile(absolute)
    if (sha256(existing) !== hash) throw new Error(`归档文件已存在且内容不同：${normalized}`)
    return { bytes: existing.byteLength, sha256: hash }
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  await mkdir(path.dirname(absolute), { recursive: true })
  await assertNoSymlinks(root, absolute)
  await writeFileAtomic(absolute, content)
  return { bytes: content.byteLength, sha256: hash }
}

function parseCases(summary: unknown): Array<{ id: string; status: string; evidence?: string }> {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return []
  const cases = (summary as { cases?: unknown }).cases
  if (!Array.isArray(cases)) return []
  const rows: Array<{ id: string; status: string; evidence?: string }> = []
  for (const item of cases) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id === '' || typeof row.status !== 'string') continue
    rows.push({ id: row.id, status: row.status, ...(typeof row.evidence === 'string' && row.evidence !== '' ? { evidence: row.evidence } : {}) })
  }
  return rows
}

/**
 * 把当前 summary、summary 引用的逐例证据和约定 evidence/<CaseID>/ 目录复制到
 * 本次执行唯一目录。只读当前需求；跳过已有 executions 归档，避免递归复制。
 */
export async function archiveCaseEvidence(input: {
  workspaceDir: string
  archiveDir: string
  label: 'prior' | 'current'
  extra?: Array<{ name: string; content: string | Buffer }>
}): Promise<ExecutionArchiveResult> {
  const workspace = await realpath(input.workspaceDir)
  const directory = assertExecutionDir(input.archiveDir)
  const targetRoot = `${directory}/${input.label}`
  const files: ExecutionArchiveFile[] = []
  const missing: string[] = []
  let cases: Array<{ id: string; status: string; evidence?: string }> = []
  let summaryError: string | undefined
  const summaryRelative = 'evidence/summary.json'
  const summaryAbsolute = path.join(workspace, summaryRelative)
  let summaryText: string | undefined
  try {
    await assertNoSymlinks(workspace, summaryAbsolute)
    summaryText = await readFile(summaryAbsolute, 'utf8')
  } catch (error) {
    if (!isEnoent(error)) summaryError = errorMessage(error)
  }
  if (summaryText !== undefined) {
    try {
      cases = parseCases(JSON.parse(summaryText) as unknown)
    } catch (error) {
      summaryError = `summary 不是有效 JSON：${errorMessage(error)}`
    }
  }
  const sources = new Set<string>()
  if (summaryText !== undefined) sources.add(summaryRelative)
  for (const row of cases) {
    if (row.evidence !== undefined) {
      try {
        for (const file of await existingFiles(workspace, row.evidence, missing)) sources.add(file)
      } catch (error) {
        missing.push(`${row.evidence}（${errorMessage(error)}）`)
      }
    }
    try {
      for (const file of await existingFiles(workspace, `evidence/${row.id}`, missing)) sources.add(file)
    } catch (error) {
      missing.push(`evidence/${row.id}（${errorMessage(error)}）`)
    }
  }
  for (const relative of [...sources].sort()) {
    const content = await readFile(path.join(workspace, relative))
    const written = await writeImmutable(workspace, `${targetRoot}/${relative}`, content)
    files.push({ path: relative, archivePath: `${targetRoot}/${relative}`, ...written })
  }
  for (const extra of input.extra ?? []) {
    const name = assertRelative(extra.name, '附加归档文件名')
    const content = Buffer.isBuffer(extra.content) ? extra.content : Buffer.from(extra.content, 'utf8')
    const written = await writeImmutable(workspace, `${targetRoot}/${name}`, content)
    files.push({ path: name, archivePath: `${targetRoot}/${name}`, ...written })
  }
  return {
    directory: targetRoot,
    files,
    cases,
    missing,
    ...(summaryError === undefined ? {} : { error: summaryError }),
  }
}

export async function writeExecutionArchiveText(
  workspaceDir: string,
  archiveDir: string,
  name: string,
  text: string,
): Promise<ExecutionArchiveFile> {
  const workspace = await realpath(workspaceDir)
  const directory = assertExecutionDir(archiveDir)
  const file = assertRelative(name, '归档文件名')
  const written = await writeImmutable(workspace, `${directory}/${file}`, Buffer.from(text, 'utf8'))
  return { path: file, archivePath: `${directory}/${file}`, ...written }
}

export async function writeExecutionReceipt(
  workspaceDir: string,
  archiveDir: string,
  receipt: Record<string, unknown>,
): Promise<ExecutionReceiptRef> {
  const workspace = await realpath(workspaceDir)
  const directory = assertExecutionDir(archiveDir)
  const content = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  const written = await writeImmutable(workspace, `${directory}/receipt.json`, content)
  return { path: `${directory}/receipt.json`, ...written }
}

/** 读取本次运行的所有执行 receipt，用于质量报告和失败/恢复关联。 */
export async function readExecutionReceipts(workspaceDir: string, runId: string): Promise<ExecutionReceiptReadResult> {
  const workspace = await realpath(workspaceDir)
  const runSegment = safeSegment(runId, 'run')
  const root = path.join(workspace, EXECUTIONS_ROOT, runSegment)
  const receipts: ExecutionReceiptRecord[] = []
  const errors: Array<{ path: string; error: string }> = []
  let nodes
  try {
    nodes = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isEnoent(error)) return { receipts, errors }
    throw error
  }
  for (const node of nodes.sort((left, right) => left.name.localeCompare(right.name))) {
    const nodePath = `${EXECUTIONS_ROOT}/${runSegment}/${node.name}`
    if (!node.isDirectory() || node.isSymbolicLink()) continue
    const nodeDir = path.join(root, node.name)
    let executions
    try {
      executions = await readdir(nodeDir, { withFileTypes: true })
    } catch (error) {
      errors.push({ path: nodePath, error: errorMessage(error) })
      continue
    }
    for (const execution of executions.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!execution.isDirectory() || execution.isSymbolicLink()) continue
      const relative = `${EXECUTIONS_ROOT}/${runSegment}/${node.name}/${execution.name}/receipt.json`
      try {
        await assertNoSymlinks(workspace, path.join(workspace, relative))
        const text = await readFile(path.join(workspace, relative), 'utf8')
        const parsed: unknown = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('receipt 不是对象')
        receipts.push({ path: relative, sha256: sha256(text), receipt: parsed as Record<string, unknown> })
      } catch (error) {
        if (!isEnoent(error)) errors.push({ path: relative, error: errorMessage(error) })
      }
    }
  }
  receipts.sort((left, right) => {
    const leftAt = typeof left.receipt.startedAt === 'string' ? left.receipt.startedAt : ''
    const rightAt = typeof right.receipt.startedAt === 'string' ? right.receipt.startedAt : ''
    return leftAt.localeCompare(rightAt) || left.path.localeCompare(right.path)
  })
  return { receipts, errors }
}
