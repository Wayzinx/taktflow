import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { AgentProfile, HarnessSelector, TaktConfig } from '../types.js'
import { parseFrontmatter } from '../util/frontmatter.js'
import { FsAttentionStore } from './fs-attention.js'
import { FsEventStore } from './fs-events.js'
import { FsRunStore } from './fs-runs.js'
import { FsWorkspaceStore } from './fs-workspace.js'
import { fileExists, isEnoent, readJsonFile, toJsonText, writeFileIfAbsent } from './fs-utils.js'
import { withLock } from './locks.js'

const CONFIG_FILE = 'takt.config.json'
const DEFAULT_WORKFLOW = '.takt/workflows/sdlc.workflow.ts'
const TAKT_SUBDIRS = ['agents', 'workflows', 'workspaces', 'objects', 'runs'] as const

/** 初始化项目：创建配置和 `.takt/` 目录，已存在的文件不覆盖。 */
export async function initProject(projectDir: string, options?: { name?: string }): Promise<ProjectStores> {
  await mkdir(projectDir, { recursive: true })
  const configFile = path.join(projectDir, CONFIG_FILE)
  await withLock(configFile, async () => {
    const config: TaktConfig = {
      project: { name: options?.name ?? path.basename(path.resolve(projectDir)) },
      workflows: [DEFAULT_WORKFLOW],
    }
    await writeFileIfAbsent(configFile, toJsonText(config))
  })
  for (const dir of TAKT_SUBDIRS) await mkdir(path.join(projectDir, '.takt', dir), { recursive: true })
  return openProject(projectDir)
}

/** 打开项目；projectDir 里没有配置时向上查找父目录。 */
export async function openProject(projectDir: string): Promise<ProjectStores> {
  const root = await findProjectRoot(path.resolve(projectDir))
  const configFile = path.join(root, CONFIG_FILE)
  const config = await readJsonFile<unknown>(configFile)
  if (config === undefined) throw new Error(`未找到配置文件：${configFile}`)
  const taktDir = path.join(root, '.takt')
  return {
    projectDir: root,
    taktDir,
    config: assertConfig(config, configFile),
    workspaces: new FsWorkspaceStore(taktDir),
    events: new FsEventStore(taktDir),
    runs: new FsRunStore(taktDir),
    attention: new FsAttentionStore(taktDir),
  }
}

/** 读 `.takt/agents/*.md`：frontmatter 是结构化字段，正文是角色说明。 */
export async function loadProfiles(taktDir: string): Promise<Record<string, AgentProfile>> {
  const dir = path.join(taktDir, 'agents')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (isEnoent(err)) return {}
    throw err
  }
  const profiles: Record<string, AgentProfile> = {}
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of files) {
    const file = path.join(dir, entry.name)
    const { data, body } = parseFrontmatter(await readFile(file, 'utf8'))
    const profile = toProfile(file, entry.name, data, body)
    if (profiles[profile.role] !== undefined) throw new Error(`角色重复：${profile.role}（${file}）`)
    profiles[profile.role] = profile
  }
  return profiles
}

async function findProjectRoot(start: string): Promise<string> {
  let dir = start
  for (;;) {
    if (await fileExists(path.join(dir, CONFIG_FILE))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`向上未找到 ${CONFIG_FILE}：${start}`)
    dir = parent
  }
}

function assertConfig(value: unknown, file: string): TaktConfig {
  if (typeof value !== 'object' || value === null) throw new Error(`配置不是对象：${file}`)
  const config = value as TaktConfig
  if (typeof config.project?.name !== 'string' || config.project.name === '' || !Array.isArray(config.workflows)) {
    throw new Error(`配置缺 project.name 或 workflows：${file}`)
  }
  return config
}

function toProfile(file: string, fileName: string, data: Record<string, unknown>, body: string): AgentProfile {
  const role = readString(data, 'role') ?? fileName.replace(/\.md$/, '')
  const profile: AgentProfile = {
    role,
    title: readString(data, 'title') ?? role,
    description: readString(data, 'description') ?? '',
    harness: readHarness(data, file),
    skills: readStringList(data, 'skills', file),
    writeScope: readStringList(data, 'writeScope', file),
    instructions: body.trim(),
  }
  const readScope = data.readScope
  if (readScope !== undefined) {
    if (!Array.isArray(readScope) || readScope.some((item) => typeof item !== 'string')) {
      throw new Error(`角色档案 readScope 必须是字符串数组：${file}`)
    }
    profile.readScope = readScope as string[]
  }
  return profile
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readStringList(data: Record<string, unknown>, key: string, file: string): string[] {
  const value = data[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`角色档案 ${key} 必须是字符串数组：${file}`)
  }
  return value as string[]
}

function readHarness(data: Record<string, unknown>, file: string): HarnessSelector {
  const value = data.harness
  if (typeof value === 'string' && value !== '') return { harness: value }
  if (typeof value === 'object' && value !== null && typeof (value as { harness?: unknown }).harness === 'string') {
    return value as HarnessSelector
  }
  throw new Error(`角色档案缺 harness（或格式不对）：${file}`)
}
