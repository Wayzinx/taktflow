import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { sha256 } from '../util/hash.js'
import { withFileLock } from './file-lock.js'
import { ownerIsDead } from './process-file.js'

const roots: string[] = []
const execute = (script: string, ...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, ...args])
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'takt-lock-recovery-'))); roots.push(root)
  const { stdout } = await execute('console.log(process.pid)')
  const pid = Number(stdout.trim())
  expect(ownerIsDead({ pid })).toBe(true)
  return { root, key: join(root, 'data'), pid }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([true, false])('回收死进程锁，兼容旧格式（host=%s）', async modern => {
  const { key, pid } = await fixture()
  await writeFile(`${key}.lock`, JSON.stringify({ pid, ...(modern ? { host: hostname() } : {}) }))
  await withFileLock(key, async () => {
    expect(JSON.parse(await readFile(`${key}.lock`, 'utf8'))).toEqual({ pid: process.pid, host: hostname() })
  })
  await expect(readFile(`${key}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['live', 'foreign', 'invalid', 'eperm'])('%s 锁不能被回收，仍超时报错', async kind => {
  const { key, pid } = await fixture()
  const content = kind === 'invalid' ? '{' : JSON.stringify({ pid: kind === 'live' ? process.pid : pid, host: kind === 'foreign' ? `${hostname()}-other` : hostname() })
  await writeFile(`${key}.lock`, content)
  if (kind === 'eperm') vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('无权限'), { code: 'EPERM' }) })
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_001)
  const work = vi.fn()
  await expect(withFileLock(key, work)).rejects.toThrow('等待文件锁超时')
  expect(work).not.toHaveBeenCalled()
  expect(await readFile(`${key}.lock`, 'utf8')).toBe(content)
})

it('回收锁自身遗留时也按持有进程判活', async () => {
  const { root, key, pid } = await fixture()
  const file = `${key}.lock`, content = JSON.stringify({ pid, host: hostname() })
  await writeFile(file, content)
  const info = await stat(file, { bigint: true })
  const identity = sha256(`${info.dev}:${info.ino}:${info.birthtimeNs}:${content}`)
  const reclaim = join(root, `${sha256(file + identity)}.reclaim`)
  await writeFile(reclaim, content)
  await withFileLock(key, async () => {})
  expect(await readdir(root)).toEqual([])
})

it('两个独立进程竞争同一死锁，临界区并发数始终不超过一', async () => {
  const { root, key, pid } = await fixture()
  await writeFile(`${key}.lock`, JSON.stringify({ pid }))
  const journal = join(root, 'critical.jsonl')
  const script = `import { withFileLock } from ${JSON.stringify(new URL('./file-lock.ts', import.meta.url).href)};
    import { appendFile } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    for (let i=0; i<8; i++) await withFileLock(process.argv[1], async () => {
      await appendFile(process.argv[2], JSON.stringify({pid:process.pid, delta:1})+'\\n');
      await setTimeout(15);
      await appendFile(process.argv[2], JSON.stringify({pid:process.pid, delta:-1})+'\\n');
    });`
  await Promise.all([execute(script, key, journal), execute(script, key, journal)])
  const records = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {pid:number;delta:number})
  expect(new Set(records.map(item => item.pid)).size).toBe(2)
  expect(records).toHaveLength(32)
  let active = 0
  for (const item of records) { active += item.delta; expect(active).toBeGreaterThanOrEqual(0); expect(active).toBeLessThanOrEqual(1) }
  expect(active).toBe(0)
})
