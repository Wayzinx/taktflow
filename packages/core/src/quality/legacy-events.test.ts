import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FsEventStore } from '../store/fs-events.js'
import { eventsFile } from '../store/paths.js'

// 按 M3 固定业务信封的算法预先生成；不可用待测链工具动态生成 fixture。
const legacy = `{"seq":1,"ts":"2026-11-04T00:00:00.000Z","runId":"legacy-run","type":"log","actor":{"type":"system","id":"fixture"},"data":{"level":"info","message":"旧事件 1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"8c51a66974e775f7e3ef2efa72305e7ac2131c503894cd8b27a5132ff083582f"}
{"seq":2,"ts":"2026-11-04T00:00:00.000Z","runId":"legacy-run","type":"log","actor":{"type":"system","id":"fixture"},"data":{"level":"info","message":"旧事件 2"},"nodeId":"review","prevHash":"8c51a66974e775f7e3ef2efa72305e7ac2131c503894cd8b27a5132ff083582f","hash":"6a48df44fe4a5bff3d124c2c42f3993a3662e7fd65cbaac36243eee616bdcc4f"}
`
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('旧事件 fixture 原哈希不变，新追加可接续，篡改仍定位到第二项', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-legacy-events-')); roots.push(root)
  const store = new FsEventStore(root), file = eventsFile(root, 'legacy-run')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, legacy)
  expect(await store.verify('legacy-run')).toEqual({ ok: true })
  const added = await store.append('legacy-run', { type: 'log', actor: { type: 'system', id: 'test' }, data: { level: 'info', message: '新事件' } })
  expect(added).toMatchObject({ seq: 3, prevHash: '6a48df44fe4a5bff3d124c2c42f3993a3662e7fd65cbaac36243eee616bdcc4f' })
  expect(await store.verify('legacy-run')).toEqual({ ok: true })
  await writeFile(file, legacy.replace('旧事件 2', '被篡改'))
  expect(await store.verify('legacy-run')).toEqual({ ok: false, brokenAt: 2 })
})

it('旧 verify 允许空行、无末尾换行与非业务信封扩展字段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-legacy-events-')); roots.push(root)
  const store = new FsEventStore(root), file = eventsFile(root, 'legacy-run')
  await mkdir(dirname(file), { recursive: true })
  const lines = legacy.trimEnd().split('\n').map(line => JSON.stringify({ ...JSON.parse(line), legacyExtension: true }))
  await writeFile(file, `\n  \n${lines.join('\n\n')}`)
  expect(await store.verify('legacy-run')).toEqual({ ok: true })
  expect(await store.read('legacy-run')).toHaveLength(2)
})
