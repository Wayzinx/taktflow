import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type { ProjectStores, SpaceMember } from '@taktflow/core'
import { afterEach, expect, it } from 'vitest'
import { FeishuBindings, feishuBindingRoutes, type FeishuBinding } from './feishu-bindings.js'
import { createRouter } from './router.js'
import type { Handler } from './routes.js'

const roots: string[] = []
const path = '/api/space/feishu'
const member = (id: string, role: SpaceMember['role']): SpaceMember => ({ id, name: id, role })
const alpha = [member('alice', 'owner'), member('bob', 'member'), member('max', 'maintainer'), member('web', 'owner')]
const beta = [member('bea', 'owner'), member('alice', 'viewer')]
const input = { chatId: 'oc_alpha', members: [{ openId: 'ou_a', memberId: 'alice' }, { openId: 'ou_b', memberId: 'bob' }] }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'takt-feishu-bindings-'))
  roots.push(parent)
  const root = join(parent, 'feishu')
  const bindings = new FeishuBindings(root)
  function client(id: string, members?: SpaceMember[], configured = true) {
    const stores = { config: { space: { id }, members } } as ProjectStores
    const router = createRouter<Handler>()
    feishuBindingRoutes(router.add, bindings, configured)
    async function call(method: string, user?: string, payload?: unknown) {
      const match = router.match(method, path)!
      const stream = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
      const request = Object.assign(stream, { method, headers: user === undefined ? {} : { 'x-takt-user': user } }) as IncomingMessage
      return await match.handler({ stores, request, response: {} as ServerResponse, params: match.params, url: new URL(`http://localhost${path}?spaceId=beta`) }) as { configured: boolean; binding: FeishuBinding | null }
    }
    return { get: (user?: string) => call('GET', user), put: (user: string | undefined, payload: unknown) => call('PUT', user, payload) }
  }
  return { root, parent, bindings, client }
}

it('GET 和 PUT 只认显式提供的当前空间 owner，不能借默认身份或其他空间越权', async () => {
  const { client, bindings } = await fixture()
  const current = client('alpha', alpha)
  const other = client('beta', beta)
  expect(await current.get('alice')).toEqual({ configured: true, binding: null })
  expect(await client('alpha', alpha, false).get('alice')).toEqual({ configured: false, binding: null })
  for (const user of [undefined, ' ', 'web', 'bob', 'max', 'bea']) {
    await expect(current.get(user)).rejects.toMatchObject({ status: 403 })
    await expect(current.put(user, {})).rejects.toMatchObject({ status: 403 })
  }
  for (const members of [undefined, [], [member('alice', 'member')]]) {
    const changed = client('alpha', members)
    await expect(changed.get('alice')).rejects.toMatchObject({ status: 403 })
    await expect(changed.put('alice', { ...input, baseRevision: null })).rejects.toMatchObject({ status: 403 })
  }
  await expect(other.get('alice')).rejects.toMatchObject({ status: 403 })
  const saved = await current.put('alice', { ...input, baseRevision: null, spaceId: 'beta', appSecret: 'not-stored' })
  expect(await other.get('bea')).toEqual({ configured: true, binding: null })
  expect(await current.get('alice')).toEqual(saved)
  expect(await bindings.find(input.chatId)).toEqual({ spaceId: 'alpha', binding: saved.binding })
})

it('校验 CAS、会话与成员映射，不接受其他空间成员或重复身份', async () => {
  const { client, bindings } = await fixture()
  const { put } = client('alpha', alpha)
  for (const invalid of [
    { baseRevision: undefined }, { baseRevision: 0 }, { baseRevision: ' ' },
    { chatId: 'ou_alice' }, { chatId: 'oc_' }, { chatId: 'oc_group/extra' },
    { members: null }, { members: ['alice'] }, { members: [{ openId: 'on_a', memberId: 'alice' }] },
    { members: [{ openId: 'ou_a', memberId: 'bea' }] }, { members: [{ openId: 'ou_a', memberId: 'web' }] },
    { members: [input.members[0], { openId: 'ou_a', memberId: 'bob' }] },
    { members: [input.members[0], { openId: 'ou_b', memberId: 'alice' }] },
  ]) {
    await expect(put('alice', { ...input, baseRevision: null, ...invalid })).rejects.toMatchObject({ status: 400 })
  }
  expect(await bindings.get('alpha')).toBeNull()
})

it('旧 revision 不能重写或撤销；幂等不改 revision，变更与重绑撤销旧 revision', async () => {
  const { root, client } = await fixture()
  const { put } = client('alpha', alpha)
  const initial = (await put('alice', { ...input, baseRevision: null, appSecret: 'not-stored' })).binding!
  const restarted = new FeishuBindings(root)
  expect(initial).toEqual({ ...input, revision: expect.any(String), updatedAt: expect.any(String) })
  expect(await restarted.get('alpha')).toEqual(initial)
  expect((await stat(join(root, 'bindings.json'))).mode & 0o777).toBe(0o600)
  expect(await readFile(join(root, 'bindings.json'), 'utf8')).not.toContain('not-stored')
  const unchanged = await put('alice', { ...input, members: [...input.members].reverse(), baseRevision: initial.revision })
  expect(unchanged.binding).toEqual(initial)
  await expect(put('alice', { ...input, baseRevision: null })).rejects.toMatchObject({ status: 409 })
  await expect(client('beta', beta).put('bea', { chatId: input.chatId, members: [], baseRevision: null })).rejects.toMatchObject({ status: 409 })

  const changed = (await put('alice', { ...input, members: input.members.slice(0, 1), baseRevision: initial.revision })).binding!
  expect(changed.revision).not.toBe(initial.revision)
  expect((await restarted.find(input.chatId))?.binding).toEqual(changed)
  await expect(put('alice', { chatId: null, baseRevision: initial.revision })).rejects.toMatchObject({ status: 409 })
  expect((await put('alice', { chatId: null, baseRevision: changed.revision })).binding).toBeNull()
  expect(await restarted.get('alpha')).toBeNull()
  expect(await restarted.find(input.chatId)).toBeUndefined()
  expect((await put('alice', { chatId: null, baseRevision: null })).binding).toBeNull()

  const transferred = (await client('beta', beta).put('bea', { chatId: input.chatId, members: [], baseRevision: null })).binding!
  expect(new Set([initial.revision, changed.revision, transferred.revision]).size).toBe(3)
  expect(await restarted.find(input.chatId)).toEqual({ spaceId: 'beta', binding: transferred })
})

it('独立进程竞争时只接受一个相同会话或相同基线的写入，其他空间更新不丢失', async () => {
  const { root, parent, bindings } = await fixture()
  const gate = join(parent, 'ready')
  await mkdir(gate)
  const baseline = (await bindings.update('charlie', { chatId: 'oc_old', members: [] }, null))!.revision
  const contenders = [
    ['alpha', 'oc_shared', null], ['beta', 'oc_shared', null],
    ['charlie', 'oc_left', baseline], ['charlie', 'oc_right', baseline], ['delta', 'oc_other', null],
  ] as const
  const script = `
    import { FeishuBindings } from ${JSON.stringify(new URL('./feishu-bindings.ts', import.meta.url).href)}
    import { readdir, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { setTimeout } from 'node:timers/promises'
    const [root, gate, id, input] = process.argv.slice(1)
    const [spaceId, chatId, baseRevision] = JSON.parse(input)
    await writeFile(join(gate, id), '')
    while ((await readdir(gate)).length < ${contenders.length}) await setTimeout(10)
    try { console.log(JSON.stringify(await new FeishuBindings(root).update(spaceId, { chatId, members: [] }, baseRevision))) }
    catch (error) { if (error.status !== 409) throw error; console.log('409') }
  `
  const run = promisify(execFile)
  const results = await Promise.all(contenders.map(async (candidate, index) => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, gate, String(index), JSON.stringify(candidate)], { timeout: 15_000 })
    return JSON.parse(stdout) as FeishuBinding | 409
  }))
  expect(results.slice(0, 2).filter(result => result === 409)).toHaveLength(1)
  expect(results.slice(2, 4).filter(result => result === 409)).toHaveLength(1)
  expect(results[4]).toMatchObject({ chatId: 'oc_other' })
  for (const [index, result] of results.entries()) {
    if (result !== 409) expect(await bindings.find(result.chatId)).toEqual({ spaceId: contenders[index]![0], binding: result })
  }
  expect(await bindings.find('oc_old')).toBeUndefined()
})

it('拒绝根目录、祖先、注册表及写锁上的符号链接', async () => {
  const { root, parent, bindings } = await fixture()
  const target = join(parent, 'target')
  const outside = join(target, 'data.json')
  await mkdir(target)
  await writeFile(outside, '{}')
  await symlink(target, root, 'dir')
  await expect(bindings.get('alpha')).rejects.toThrow(/符号链接/)
  await expect(new FeishuBindings(join(root, 'child')).update('alpha', input, null)).rejects.toThrow(/符号链接/)
  await expect(stat(join(target, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })

  await rm(root)
  await mkdir(root)
  await symlink(outside, join(root, 'bindings.json'))
  await expect(bindings.find(input.chatId)).rejects.toThrow()
  await expect(bindings.update('alpha', input, null)).rejects.toThrow()
  expect(await readFile(outside, 'utf8')).toBe('{}')

  await rm(join(root, 'bindings.json'))
  await symlink(target, join(root, 'bindings.lock'), 'dir')
  await expect(bindings.update('alpha', input, null)).rejects.toThrow(/符号链接/)
  expect(await bindings.get('alpha')).toBeNull()
})
