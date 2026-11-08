import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { listFiles, matchGlob } from '../util/glob.js'
import { sha256 } from '../util/hash.js'
import type { ArtifactRecord } from '../types.js'
import { assertNoSymlinks, isEnoent, readJsonFile } from '../store/fs-utils.js'
import { withLock } from '../store/locks.js'

type Scope = { profile: string[]; node?: string[] }
type SystemChange = { before?: Map<string, string>; after?: Map<string, string>; done: Promise<void> }
type Window = { scope: Scope; start: number; end: number; uncertain?: boolean; system?: boolean; change?: SystemChange }
const guards = new Map<string, Set<WeakRef<WriteGuard>>>()
const collected = new FinalizationRegistry<{ root: string; ref: WeakRef<WriteGuard> }>(({ root, ref }) => {
  const entries = guards.get(root)
  entries?.delete(ref)
  if (!entries?.size) guards.delete(root)
})

// 同根的受控写入串行记账，避免交叠窗口把另一笔写入算进自己的哈希变化。
export function systemWrite<T>(root: string, paths: string[], fn: () => Promise<T>): Promise<T> {
  root = resolve(root)
  return withLock(join(root, '.takt/system-write'), async () => {
    const live: WriteGuard[] = []
    const entries = guards.get(root)
    for (const ref of entries ?? []) {
      const guard = ref.deref()
      if (guard) live.push(guard)
      else entries!.delete(ref)
    }
    if (!entries?.size) guards.delete(root)
    if (!live.length) return fn()
    let finish!: () => void
    const change: SystemChange = { done: new Promise<void>(resolve => { finish = resolve }) }
    const scan = async () => {
      const files = await listFiles(root, paths)
      const hashes = new Map<string, string>()
      await Promise.all(files.map(async file => {
        try { hashes.set(file, sha256(await readFile(join(root, file)))) } catch (error) { if (!isEnoent(error)) throw error }
      }))
      return hashes
    }
    const run = async (index: number): Promise<T> => {
      if (index < live.length) return live[index]!.system(paths, () => run(index + 1), false, change)
      change.before = await scan()
      try { return await fn() } finally { change.after = await scan() }
    }
    try { return await run(0) } finally { finish() }
  })
}
const allowed = (scope: Scope, file: string) => scope.profile.some((p) => matchGlob(p, file)) &&
  (scope.node === undefined || scope.node.some((p) => matchGlob(p, file)))

function metadata(file: string, requirements: string): boolean {
  const relative = file.startsWith(`${requirements}/`) ? file.slice(requirements.length + 1) : ''
  if (/^[^/]+\/(manifest\.json|requirement\.json|comments\.jsonl)(?:\.[\da-f]+\.tmp|\.lock)?$/.test(relative)) return true
  // 质量日志与运行事件同属存储元数据；实时同步不归因给正在执行的模型。候选包和快照不豁免。
  return /^\.takt\/quality\/(?:log\.jsonl|anchor\.json|cursors\.json|views\/[^/]+\.json|eval-mutations|defect-projections)(?:\.[\da-f]+\.tmp|\.lock)?$/.test(file) ||
    /^\.takt\/(runs|objects|chat)\//.test(file) ||
    /^\.takt\/attention\.jsonl(?:\.[\da-f]+\.tmp|\.lock)?$/.test(file) ||
    /^\.takt\/workspaces\/[^/]+\/(manifest\.json|requirement\.json|comments\.jsonl)(?:\.[\da-f]+\.tmp)?$/.test(file)
}

async function snapshot(root: string, requirements: string): Promise<Map<string, string>> {
  const files = await listFiles(root, ['**'], { ignore: ['**/.git', '**/node_modules', '.takt/runs', '.takt/objects', '.takt/worktrees', '.takt/repos', '.takt/quarantine'] })
  const map = new Map<string, string>()
  await Promise.all(files.filter((file) => !metadata(file, requirements)).map(async (file) => {
    try { map.set(file, sha256(await readFile(join(root, file)))) } catch (error) { if (!isEnoent(error)) throw error }
  }))
  return map
}

async function humanVersions(root: string, requirements: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>()
  const manifests = await listFiles(root, [`${requirements}/*/manifest.json`], { ignore: ['**/.git', '**/node_modules', '.takt/runs', '.takt/objects', '.takt/worktrees', '.takt/repos', '.takt/quarantine'] })
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
  private readonly outputWindows: Array<{ workspace: string; outputs: string[]; start: number; end: number }> = []
  constructor(private readonly root: string, private readonly requirements = '.takt/workspaces') {
    const key = resolve(root), ref = new WeakRef(this)
    const entries = guards.get(key) ?? new Set<WeakRef<WriteGuard>>()
    entries.add(ref)
    guards.set(key, entries)
    collected.register(this, { root: key, ref })
  }

  async system<T>(paths: string[], fn: () => Promise<T>, uncertain = false, change?: SystemChange): Promise<T> {
    const window: Window = { scope: { profile: paths }, start: ++this.clock, end: Infinity, uncertain, system: true, change }
    this.windows.push(window)
    try { return await fn() } finally { this.close(window) }
  }

  private close(window: Window): void {
    window.end = ++this.clock
    this.prune()
  }

  private prune(): void {
    const earliest = Math.min(...this.windows.filter((item) => item.end === Infinity).map((item) => item.start), ...this.outputWindows.filter((item) => item.end === Infinity).map((item) => item.start))
    for (let index = this.windows.length - 1; index >= 0; index--) {
      if (this.windows[index]!.end < earliest) this.windows.splice(index, 1)
    }
    for (let index = this.outputWindows.length - 1; index >= 0; index--) {
      if (this.outputWindows[index]!.end < earliest) this.outputWindows.splice(index, 1)
    }
  }

  async watchOutputs(workspace: string, outputs: string[], quarantine?: string): Promise<() => Promise<Array<{ path: string; sha256: string }>>> {
    const window = { workspace, outputs, start: ++this.clock, end: Infinity }
    this.outputWindows.push(window)
    let finish: () => Promise<Array<{ path: string; sha256: string }>>
    try {
      const humans = await humanVersions(this.root, this.requirements)
      finish = await watchOutputs(workspace, outputs, quarantine, async (path) => {
        if (this.outputWindows.some((peer) => peer !== window && peer.workspace === workspace && peer.end >= window.start &&
          peer.outputs.some((pattern) => matchGlob(pattern, path)))) return true
        const file = relative(this.root, join(workspace, path))
        if (this.windows.some((peer) => peer.system && peer.end >= window.start && allowed(peer.scope, file))) return true
        const latest = await humanVersions(this.root, this.requirements)
        return latest.has(file) && latest.get(file) !== humans.get(file)
      })
    } catch (error) { this.outputWindows.splice(this.outputWindows.indexOf(window), 1); throw error }
    return async () => {
      try { return await finish() } finally {
        window.end = ++this.clock
        this.prune()
      }
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
        await Promise.all(this.windows.filter(w => w.change && w.end === Infinity).map(w => w.change!.done))
        const [after, latestHumans] = await Promise.all([snapshot(this.root, this.requirements), humanVersions(this.root, this.requirements)])
        const peers = this.windows.filter((w) => w.end >= window.start)
        const controlled = peers.filter(peer => peer.change?.before && peer.change.after)
        const candidates = new Set([...before.keys(), ...after.keys(), ...controlled.flatMap(peer => [...peer.change!.before!.keys(), ...peer.change!.after!.keys()])])
        const paths = [...candidates].filter(file => {
          if (peers.some(peer => !peer.change && allowed(peer.scope, file))) return false
          let expected = before.get(file)
          for (const peer of controlled) {
            if (!allowed(peer.scope, file)) continue
            // 只扣除受控窗口的状态变化；窗口之前或之后的 agent 改动仍需报告。
            if (peer.start >= window.start && expected !== peer.change!.before!.get(file)) return true
            expected = peer.change!.after!.get(file)
          }
          return expected !== after.get(file)
        })
        // 文件快照无法证明写入者；checkout 或回写旧字节都可能覆盖人工、暂存或并发改动。
        return { paths, action: 'flagged', ambiguous: peers.some((peer) => peer !== window && peer.uncertain) ||
          paths.some((file) => latestHumans.has(file) && latestHumans.get(file) !== humans.get(file)) }
      } finally { this.close(window) }
    }
  }
}

// 只检查本次执行期间变化的业务文件，不能把原有草稿或存储元数据当作新产物。
async function watchOutputs(workspace: string, outputs: string[], quarantine?: string, exclude: (path: string) => Promise<boolean> = async () => false): Promise<() => Promise<Array<{ path: string; sha256: string }>>> {
  const scan = async () => {
    const files = await listFiles(workspace, ['**'], { ignore: [] })
    const contents = new Map<string, { hash: string; bytes?: Buffer }>()
    for (const path of files) {
      if (/^(manifest\.json|requirement\.json|comments\.jsonl)(?:$|\.)/.test(path) || /\.[a-f0-9]{16}\.tmp$/.test(path)) continue
      await assertNoSymlinks(workspace, join(workspace, path))
      try {
        const bytes = await readFile(join(workspace, path))
        contents.set(path, { hash: sha256(bytes), ...(quarantine ? { bytes } : {}) })
      } catch (error) { if (!isEnoent(error)) throw error }
    }
    return contents
  }
  const before = await scan()
  return async () => {
    const after = await scan()
    const changed: Array<{ path: string; sha256: string }> = []
    for (const [path, content] of after) {
      if (before.get(path)?.hash === content.hash || outputs.some((pattern) => matchGlob(pattern, path)) || await exclude(path)) continue
      changed.push({ path, sha256: content.hash })
      if (quarantine) {
        const target = join(quarantine, path)
        await assertNoSymlinks(quarantine, target)
        await mkdir(dirname(target), { recursive: true })
        await rename(join(workspace, path), target)
        const previous = before.get(path)
        if (previous?.bytes) await writeFile(join(workspace, path), previous.bytes)
      }
    }
    return changed
  }
}
