import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { listFiles, matchGlob } from '../util/glob.js'
import { sha256 } from '../util/hash.js'
import { isEnoent } from '../store/fs-utils.js'

const exec = promisify(execFile)
type Scope = { profile: string[]; node?: string[] }
type Window = { scope: Scope; start: number; end: number }
const allowed = (scope: Scope, file: string) => scope.profile.some((p) => matchGlob(p, file)) &&
  (scope.node === undefined || scope.node.some((p) => matchGlob(p, file)))

function metadata(file: string): boolean {
  return /^\.takt\/(runs|objects)\//.test(file) ||
    /^\.takt\/attention\.jsonl(?:\.[\da-f]+\.tmp)?$/.test(file) ||
    /^\.takt\/workspaces\/[^/]+\/(manifest\.json|requirement\.json|comments\.jsonl)(?:\.[\da-f]+\.tmp)?$/.test(file)
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = await listFiles(root, ['**'], { ignore: ['**/.git', '**/node_modules', '.takt/runs', '.takt/objects'] })
  const map = new Map<string, string>()
  await Promise.all(files.filter((file) => !metadata(file)).map(async (file) => {
    try { map.set(file, sha256(await readFile(join(root, file)))) } catch (error) { if (!isEnoent(error)) throw error }
  }))
  return map
}

export class WriteGuard {
  private clock = 0
  private readonly windows: Window[] = []
  constructor(private readonly root: string) {}
  async begin(scope: Scope): Promise<() => Promise<{ paths: string[]; action: 'reverted' | 'flagged' }>> {
    const window: Window = { scope, start: ++this.clock, end: Infinity }
    this.windows.push(window)
    let before: Map<string, string>
    try { before = await snapshot(this.root) } catch (error) { window.end = ++this.clock; throw error }
    return async () => {
      try {
        const after = await snapshot(this.root)
        const peers = this.windows.filter((w) => w.start <= this.clock && w.end >= window.start)
        const paths = [...new Set([...before.keys(), ...after.keys()])].filter((file) =>
          before.get(file) !== after.get(file) && !peers.some((peer) => allowed(peer.scope, file)))
        let action: 'reverted' | 'flagged' = 'flagged'
        if (paths.length) {
          const git = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.root }).then(() => true, () => false)
          if (git) {
            for (const file of paths) {
              const tracked = await exec('git', ['ls-files', '--error-unmatch', '--', file], { cwd: this.root }).then(() => true, () => false)
              if (tracked) await exec('git', ['checkout', '--', file], { cwd: this.root })
              else if (!before.has(file)) await rm(join(this.root, file), { force: true })
              else continue
            }
            action = 'reverted'
          }
        }
        return { paths, action }
      } finally { window.end = ++this.clock }
    }
  }
}
