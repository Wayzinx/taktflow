import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectStores } from '../interfaces.js'
import type { RunState } from '../types.js'

const exec = promisify(execFile)
const git = async (cwd: string, args: string[]) =>
  (await exec('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout

/**
 * 运行做出来的东西在哪、怎么打开（docs/design/17 §代码仓库）。
 * 任务分支由集成节点合进 `takt/<run>/integration`，成品只在集成工作树里，默认分支上没有；
 * 网页成品（改动里的 .html）要经 HTTP 打开（ESM 模块在 file:// 下被浏览器拦下），由 takt serve 的预览端口提供。
 */
export interface RunDelivery {
  runId: string
  repo: string
  branch: string
  /** 集成工作树，相对空间目录 */
  path: string
  defaultBranch: string
  /** 集成分支已经在默认分支里 */
  merged: boolean
  /** 相对默认分支改动的文件数 */
  files: number
  /** 能直接打开的网页：改动里的 .html，index.html 在前，最多 8 个 */
  entries: string[]
  /** 改动里的说明文件（怎么跑） */
  readme?: string
}

interface IntegrationResult { repo?: unknown; path?: unknown; branch?: unknown }

/** 集成节点的结果里记着集成工作树的路径和分支；没有集成节点、或工作树已经清掉时返回 undefined。 */
export async function runDelivery(stores: ProjectStores, state: RunState): Promise<RunDelivery | undefined> {
  const branch = `takt/${state.runId}/integration`
  const found = Object.values(state.nodes).map((node) => node.result as IntegrationResult | undefined)
    .find((result) => !!result && typeof result === 'object' && result.branch === branch && typeof result.path === 'string')
  if (!found) return undefined
  const dir = found.path as string
  if (!(await stat(dir).catch(() => undefined))?.isDirectory()) return undefined
  const repo = typeof found.repo === 'string' ? found.repo : 'app'
  const defaultBranch = stores.config.repos?.find((item) => item.id === repo)?.defaultBranch ?? 'main'
  let changed: string[]
  try {
    changed = (await git(dir, ['diff', '--name-only', `${defaultBranch}...HEAD`])).split('\n').filter(Boolean)
  } catch {
    return undefined
  }
  const merged = await git(dir, ['merge-base', '--is-ancestor', 'HEAD', defaultBranch]).then(() => true, () => false)
  const visible = changed.filter((file) => !file.split('/').some((part) => part.startsWith('.')))
  const isIndex = (file: string) => /(^|\/)index\.html?$/i.test(file)
  const entries = visible.filter((file) => /\.html?$/i.test(file))
    .sort((a, b) => Number(!isIndex(a)) - Number(!isIndex(b)) || a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, 8)
  const readme = visible.find((file) => /(^|\/)README\.md$/i.test(file))
  return { runId: state.runId, repo, branch, path: relative(stores.projectDir, dir), defaultBranch, merged, files: changed.length, entries, ...(readme ? { readme } : {}) }
}
