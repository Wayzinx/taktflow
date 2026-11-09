import { parseRoleProfile } from './role-profile.js'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createQualityStore } from '../quality/index.js'
import type { ProjectStores } from '../interfaces.js'
import type { AgentProfile, SkillRecord, TaktConfig } from '../types.js'
import { parseFrontmatter } from '../util/frontmatter.js'
import { FsChatStore } from './fs-chat.js'
import { FsAttentionStore } from './fs-attention.js'
import { FsEventStore } from './fs-events.js'
import { FsRunStore } from './fs-runs.js'
import { FsWorkspaceStore } from './fs-workspace.js'
import { fileExists, isEnoent, readJsonFile, toJsonText, writeFileIfAbsent } from './fs-utils.js'
import { withLock } from './locks.js'

const CONFIG_FILE = 'takt.config.json'
export async function resolvePaths(projectDir: string, config: TaktConfig): Promise<ProjectStores['paths']> {
  const legacy = config.paths?.requirements === '.takt/workspaces' || (await Promise.all(['workspaces', 'agents', 'workflows'].map((dir) => fileExists(path.join(projectDir, '.takt', dir))))).some(Boolean)
  const root = legacy ? '.takt' : ''
  return Object.fromEntries(['agents', 'workflows', 'skills', 'knowledge', 'requirements', 'evals'].map((key) => {
    const name = key as keyof ProjectStores['paths']
    return [name, path.resolve(projectDir, config.paths?.[name] ?? path.join(root, legacy && name === 'requirements' ? 'workspaces' : name))]
  })) as ProjectStores['paths']
}

/** 初始化已有项目时保留配置和布局；新项目默认使用空间布局。 */
export async function initProject(projectDir: string, options?: { name?: string; layout?: 'legacy' | 'space' }): Promise<ProjectStores> {
  await mkdir(projectDir, { recursive: true })
  const configFile = path.join(projectDir, CONFIG_FILE)
  await withLock(configFile, async () => {
    const config: TaktConfig = {
      project: { name: options?.name ?? path.basename(path.resolve(projectDir)) },
      workflows: [options?.layout === 'legacy' ? '.takt/workflows/sdlc.workflow.ts' : 'workflows/sdlc.workflow.ts'],
      paths: options?.layout === 'legacy'
        ? { agents: '.takt/agents', workflows: '.takt/workflows', skills: '.takt/skills', knowledge: '.takt/knowledge', requirements: '.takt/workspaces' }
        : { agents: 'agents', workflows: 'workflows', skills: 'skills', knowledge: 'knowledge', requirements: 'requirements' },
    }
    await writeFileIfAbsent(configFile, toJsonText(config))
  })
  const stores = await openProject(projectDir)
  for (const dir of [...Object.values(stores.paths), ...['objects', 'runs', 'chat'].map((name) => path.join(stores.taktDir, name))]) await mkdir(dir, { recursive: true })
  return stores
}

/** 打开项目；projectDir 里没有配置时向上查找父目录。 */
export async function openProject(projectDir: string): Promise<ProjectStores> {
  const root = await findProjectRoot(path.resolve(projectDir))
  const configFile = path.join(root, CONFIG_FILE)
  const config = await readJsonFile<unknown>(configFile)
  if (config === undefined) throw new Error(`未找到配置文件：${configFile}`)
  const taktDir = path.join(root, '.takt')
  const checked = assertConfig(config, configFile)
  const paths = await resolvePaths(root, checked)
  const chat = new FsChatStore(taktDir)
  const stores: ProjectStores = {
    projectDir: root,
    taktDir,
    config: checked,
    paths, chat,
    workspaces: new FsWorkspaceStore(taktDir, paths.requirements, chat),
    events: new FsEventStore(taktDir),
    runs: new FsRunStore(taktDir),
    attention: new FsAttentionStore(taktDir),
  }
  stores.quality = createQualityStore(stores)
  return stores
}

/** 优先传解析后的 paths；兼容旧调用方传 .takt 或模板根目录。 */
export async function loadProfiles(source: string | ProjectStores['paths']): Promise<Record<string, AgentProfile>> {
  let dir: string
  if (typeof source !== 'string') dir = source.agents
  else if (path.basename(source) === '.takt' && await fileExists(path.join(path.dirname(source), CONFIG_FILE))) dir = (await openProject(path.dirname(source))).paths.agents
  else dir = path.basename(source) === 'agents' ? source : path.join(source, 'agents')
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
    const profile = parseRoleProfile(await readFile(file, 'utf8'), entry.name.replace(/\.md$/, ''))
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

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export async function listSkills(skillsDir: string): Promise<SkillRecord[]> {
  if (!await fileExists(skillsDir)) return []
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const skills: SkillRecord[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const file = path.join(skillsDir, entry.name, 'SKILL.md')
    if (!await fileExists(file)) continue
    const { data } = parseFrontmatter(await readFile(file, 'utf8'))
    let root = path.dirname(skillsDir)
    while (!await fileExists(path.join(root, CONFIG_FILE)) && path.dirname(root) !== root) root = path.dirname(root)
    if (path.dirname(root) === root) root = path.dirname(skillsDir)
    skills.push({ name: readString(data, 'name') ?? entry.name, description: readString(data, 'description') ?? '', path: path.relative(root, file) })
  }
  return skills
}

export async function listWorkflowFiles(paths: ProjectStores['paths']): Promise<string[]> {
  if (!await fileExists(paths.workflows)) return []
  return (await readdir(paths.workflows)).filter((name) => name.endsWith('.workflow.ts')).sort().map((name) => path.join(paths.workflows, name))
}
