import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { listFiles, matchGlob } from '../util/glob.js'
import { sha256 } from '../util/hash.js'
import type { ArtifactRecord } from '../types.js'
import { isEnoent, readJsonFile } from '../store/fs-utils.js'

type Scope = { profile: string[]; node?: string[] }
type Window = { scope: Scope; start: number; end: number; uncertain?: boolean }
const allowed = (scope: Scope, file: string) => scope.profile.some((p) => matchGlob(p, file)) &&
  (scope.node === undefined || scope.node.some((p) => matchGlob(p, file)))

function metadata(file: string, requirements: string): boolean {
  const relative = file.startsWith(`${requirements}/`) ? file.slice(requirements.length + 1) : ''
  if (/^[^/]+\/(manifest\.json|requirement\.json|comments\.jsonl)(?:\.[\da-f]+\.tmp|\.lock)?$/.test(relative)) return true
  return /^\.takt\/(runs|objects|chat)\//.test(file) ||
    /^\.takt\/attention\.jsonl(?:\.[\da-f]+\.tmp|\.lock)?$/.test(file) ||
    /^\.takt\/workspaces\/[^/]+\/(manifest\.json|requirement\.json|comments\.jsonl)(?:\.[\da-f]+\.tmp)?$/.test(file)
}

async function snapshot(root: string, requirements: string): Promise<Map<string, string>> {
  const files = await listFiles(root, ['**'], { ignore: ['**/.git', '**/node_modules', '.takt/runs', '.takt/objects', '.takt/worktrees', '.takt/repos'] })
  const map = new Map<string, string>()
  await Promise.all(files.filter((file) => !metadata(file, requirements)).map(async (file) => {
    try { map.set(file, sha256(await readFile(join(root, file)))) } catch (error) { if (!isEnoent(error)) throw error }
  }))
  return map
}

async function humanVersions(root: string, requirements: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>()
  const manifests = await listFiles(root, [`${requirements}/*/manifest.json`], { ignore: ['**/.git', '**/node_modules', '.takt/runs', '.takt/objects', '.takt/worktrees', '.takt/repos'] })
  for (const file of manifests) {
    const manifest = await readJsonFile<{ artifacts: ArtifactRecord[] }>(join(root, file))
    for (const artifact of manifest?.artifacts ?? []) {
      const human = artifact.versions.filter((version) => version.author.type === 'human').at(-1)
      if (human) versions.set(`${dirname(file)}/${artifact.path}`, `${human.version}:${human.sha256}`)
    }
  }
  return versions
}

export class WriteGuard {
  private clock = 0
  private readonly windows: Window[] = []
  constructor(private readonly root: string, private readonly requirements = '.takt/workspaces') {}

  async system<T>(paths: string[], fn: () => Promise<T>, uncertain = false): Promise<T> {
    const window: Window = { scope: { profile: paths }, start: ++this.clock, end: Infinity, uncertain }
    this.windows.push(window)
    try { return await fn() } finally { this.close(window) }
  }

  private close(window: Window): void {
    window.end = ++this.clock
    const earliest = Math.min(...this.windows.filter((item) => item.end === Infinity).map((item) => item.start))
    for (let index = this.windows.length - 1; index >= 0; index--) {
      if (this.windows[index]!.end < earliest) this.windows.splice(index, 1)
    }
  }

  async begin(scope: Scope): Promise<() => Promise<{ paths: string[]; action: 'flagged'; ambiguous: boolean }>> {
    const window: Window = { scope, start: ++this.clock, end: Infinity }
    this.windows.push(window)
    let before: Map<string, string>
    let humans: Map<string, string>
    try { [before, humans] = await Promise.all([snapshot(this.root, this.requirements), humanVersions(this.root, this.requirements)]) } catch (error) { this.close(window); throw error }
    return async () => {
      try {
        const [after, latestHumans] = await Promise.all([snapshot(this.root, this.requirements), humanVersions(this.root, this.requirements)])
        const peers = this.windows.filter((w) => w.end >= window.start)
        const paths = [...new Set([...before.keys(), ...after.keys()])].filter((file) =>
          before.get(file) !== after.get(file) && !peers.some((peer) => allowed(peer.scope, file)))
        // 文件快照无法证明写入者；checkout 或回写旧字节都可能覆盖人工、暂存或并发改动。
        return { paths, action: 'flagged', ambiguous: peers.some((peer) => peer !== window && peer.uncertain) ||
          paths.some((file) => latestHumans.has(file) && latestHumans.get(file) !== humans.get(file)) }
      } finally { this.close(window) }
    }
  }
}
