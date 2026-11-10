import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../types.js'
import { FsWorkspaceStore } from './fs-workspace.js'
import { fileExists } from './fs-utils.js'

const system: Actor = { type: 'system', id: 'test' }

describe('FsWorkspaceStore', () => {
  let root: string
  let taktDir: string
  let store: FsWorkspaceStore

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'takt-store-ws-'))
    taktDir = path.join(root, '.takt')
    store = new FsWorkspaceStore(taktDir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('撤回版本持久化、重复撤回不增版，重新写入相同内容恢复为新版本', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '撤回' })
    const ref = { workspace: 'REQ-001', path: 'evidence/a/result.json' }
    await store.writeArtifact({ ref, content: '{}', kind: 'evidence', author: system })
    await expect(store.withdrawArtifact({ ref, author: { type: 'human', id: 'tester' }, reason: ' ' })).rejects.toThrow('reason')
    const input = { ref, author: { type: 'human' as const, id: 'tester' }, reason: '证据无效' }
    expect(await store.withdrawArtifact(input)).toMatchObject({ version: 2 })
    expect(await store.withdrawArtifact(input)).toMatchObject({ version: 2 })
    const reopened = new FsWorkspaceStore(taktDir)
    expect(await reopened.listArtifacts(ref.workspace)).toEqual([])
    expect(await reopened.readArtifact(ref)).toBeUndefined()
    expect(await reopened.readArtifact({ ...ref, version: 2 })).toBeUndefined()
    expect((await reopened.readArtifact({ ...ref, version: 1 }))?.toString()).toBe('{}')
    expect((await reopened.listArtifacts(ref.workspace, true))[0]?.versions.at(-1)).toMatchObject({ version: 2, sha256: '', reason: '证据无效', author: input.author })
    expect(await reopened.detectUntracked(ref.workspace)).toEqual([])
    expect(await reopened.writeArtifact({ ref, content: '{}', kind: 'evidence', author: system })).toMatchObject({ version: 3 })
    expect((await reopened.readArtifact(ref))?.toString()).toBe('{}')
    expect(await reopened.listArtifacts(ref.workspace)).toHaveLength(1)
  })

  it('自动撤回在锁内复查磁盘，保留已重新生成的文件', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '重建' })
    const ref = { workspace: 'REQ-001', path: 'evidence/a.json' }
    await store.writeArtifact({ ref, content: '{}', kind: 'evidence', author: system })
    expect(await store.withdrawArtifact({ ref, author: system, reason: '已删除', onlyIfMissing: true })).toBeUndefined()
    expect((await store.listArtifacts(ref.workspace))[0]?.versions).toHaveLength(1)
  })

  it('创建需求自动编号，支持读取与更新', async () => {
    const first = await store.createRequirement({ title: '需求一' })
    expect(first.id).toBe('REQ-001')
    expect(first.status).toBe('draft')
    expect(first.links).toEqual([])

    const second = await store.createRequirement({ title: '需求二' })
    expect(second.id).toBe('REQ-002')

    const explicit = await store.createRequirement({ id: 'REQ-010', title: '指定 ID' })
    expect(explicit.id).toBe('REQ-010')

    expect((await store.getRequirement('REQ-002'))?.title).toBe('需求二')
    expect(await store.getRequirement('REQ-404')).toBeUndefined()
    expect((await store.listRequirements()).map((r) => r.id)).toEqual(['REQ-001', 'REQ-002', 'REQ-010'])

    const updated = await store.updateRequirement('REQ-001', { title: '需求一改', status: 'active' })
    expect(updated.title).toBe('需求一改')
    expect(updated.status).toBe('active')
    expect(updated.createdAt).toBe(first.createdAt)
    expect(updated.updatedAt >= first.updatedAt).toBe(true)
    expect((await store.getRequirement('REQ-001'))?.status).toBe('active')

    await expect(store.createRequirement({ id: 'REQ-001', title: '重复' })).rejects.toThrow('已存在')
    await expect(store.updateRequirement('REQ-404', { title: 'x' })).rejects.toThrow('不存在')
  })

  it('写入产物记版本、sha、内容类型和追溯 ID', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '需求' })
    const ref = await store.writeArtifact({
      ref: { workspace: 'REQ-001', path: 'spec/spec.md' },
      content: '# spec\nREQ-001 的实现见 AC-001-01，用例 TC-API-RULE-042。',
      kind: 'spec',
      author: system,
      derivedFrom: [{ workspace: 'REQ-001', path: 'inputs/prd.md' }],
      producedBy: { runId: 'run-20261104-000001', nodeId: 'write-spec' },
      title: '规格',
      tags: ['spec'],
    })
    expect(ref).toEqual({ workspace: 'REQ-001', path: 'spec/spec.md', version: 1 })

    const [record] = await store.listArtifacts('REQ-001')
    expect(record?.mediaType).toBe('text/markdown')
    expect(record?.kind).toBe('spec')
    expect(record?.title).toBe('规格')
    expect(record?.traceIds).toEqual(expect.arrayContaining(['REQ-001', 'AC-001-01', 'TC-API-RULE-042']))
    expect(record?.versions[0]?.derivedFrom).toEqual([{ workspace: 'REQ-001', path: 'inputs/prd.md' }])
    expect(record?.versions[0]?.producedBy?.nodeId).toBe('write-spec')
    expect(record?.versions[0]?.size).toBeGreaterThan(0)
    // 内容同时进内容寻址目录，供历史版本读取
    expect(await fileExists(path.join(taktDir, 'objects', record!.versions[0]!.sha256))).toBe(true)

    const content = await store.readArtifact({ workspace: 'REQ-001', path: 'spec/spec.md' })
    expect(content?.toString('utf8')).toContain('AC-001-01')
  })

  it('同内容重复写入不新增版本，改内容才新增并能读旧版本', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '需求' })
    const input = {
      ref: { workspace: 'REQ-001', path: 'spec/spec.md' },
      content: 'v1',
      kind: 'spec' as const,
      author: system,
    }
    await store.writeArtifact(input)
    const again = await store.writeArtifact(input)
    expect(again.version).toBe(1)
    expect((await store.listArtifacts('REQ-001'))[0]?.versions).toHaveLength(1)

    const second = await store.writeArtifact({ ...input, content: 'v2-revised' })
    expect(second.version).toBe(2)
    const record = (await store.listArtifacts('REQ-001'))[0]
    expect(record?.versions.map((v) => v.version)).toEqual([1, 2])
    expect((await store.readArtifact({ ...input.ref, version: 1 }))?.toString('utf8')).toBe('v1')
    expect((await store.readArtifact(input.ref))?.toString('utf8')).toBe('v2-revised')
    expect(await store.readArtifact({ workspace: 'REQ-001', path: 'spec/spec.md', version: 9 })).toBeUndefined()
  })

  it('人工修改必须写原因', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '需求' })
    const human: Actor = { type: 'human', id: 'zhang' }
    await expect(
      store.writeArtifact({
        ref: { workspace: 'REQ-001', path: 'spec/spec.md' },
        content: 'x',
        kind: 'spec',
        author: human,
      }),
    ).rejects.toThrow('reason')
    const ref = await store.writeArtifact({
      ref: { workspace: 'REQ-001', path: 'spec/spec.md' },
      content: 'x',
      kind: 'spec',
      author: human,
      reason: '补一条 AC',
    })
    expect(ref.version).toBe(1)
    const record = (await store.listArtifacts('REQ-001'))[0]
    expect(record?.versions[0]?.reason).toBe('补一条 AC')
  })

  it('拒绝穿越路径和保留的元数据文件', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '需求' })
    const write = (artifactPath: string) =>
      store.writeArtifact({
        ref: { workspace: 'REQ-001', path: artifactPath },
        content: 'x',
        kind: 'other',
        author: system,
      })
    await expect(write('../escape.md')).rejects.toThrow('非法产物路径')
    await expect(write('/etc/passwd')).rejects.toThrow('非法产物路径')
    await expect(write('a/../../b.md')).rejects.toThrow('非法产物路径')
    await expect(write('a//b.md')).rejects.toThrow('非法产物路径')
    await expect(write('manifest.json')).rejects.toThrow('元数据')
    await expect(write('comments.jsonl')).rejects.toThrow('元数据')
    await expect(store.createRequirement({ id: '../evil', title: 'x' })).rejects.toThrow('非法需求 ID')
  })

  it('detectUntracked 能发现直接改动和新增的文件', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '需求' })
    await store.writeArtifact({
      ref: { workspace: 'REQ-001', path: 'spec/spec.md' },
      content: 'v1',
      kind: 'spec',
      author: system,
    })
    await store.writeArtifact({
      ref: { workspace: 'REQ-001', path: 'inputs/note.md' },
      content: 'note',
      kind: 'input',
      author: system,
    })
    const dir = store.dir('REQ-001')
    await writeFile(path.join(dir, 'spec/spec.md'), '被人直接改了')
    await writeFile(path.join(dir, 'stray.txt'), '没人登记')

    const untracked = await store.detectUntracked('REQ-001')
    expect(untracked.map((u) => u.path)).toEqual(['spec/spec.md', 'stray.txt'])

    // 未登记的文件允许读（人直接放进存放区的物料）
    expect((await store.readArtifact({ workspace: 'REQ-001', path: 'stray.txt' }))?.toString('utf8')).toBe('没人登记')
    expect(await store.readArtifact({ workspace: 'REQ-001', path: 'nope.md' })).toBeUndefined()
    expect(await store.detectUntracked('REQ-404')).toEqual([])
  })

  it('评论按追加顺序保存，可按路径过滤', async () => {
    await store.createRequirement({ id: 'REQ-001', title: '需求' })
    await store.writeArtifact({
      ref: { workspace: 'REQ-001', path: 'spec/spec.md' },
      content: 'v1',
      kind: 'spec',
      author: system,
    })
    const first = await store.addComment('REQ-001', {
      path: 'spec/spec.md',
      version: 1,
      author: { type: 'human', id: 'u1' },
      body: '改一下',
    })
    expect(first.id).not.toBe('')
    await store.addComment('REQ-001', { path: 'inputs/note.md', version: 1, author: system, body: '收到' })

    expect((await store.listComments('REQ-001')).map((c) => c.body)).toEqual(['改一下', '收到'])
    expect((await store.listComments('REQ-001', 'spec/spec.md')).map((c) => c.id)).toEqual([first.id])
    await expect(
      store.addComment('REQ-001', { path: 'spec/spec.md', version: 0, author: system, body: 'x' }),
    ).rejects.toThrow('版本')
  })

  it('并发写入同一产物不丢版本（跨实例共享队列）', async () => {
    const a = new FsWorkspaceStore(taktDir)
    const b = new FsWorkspaceStore(taktDir)
    await a.createRequirement({ id: 'REQ-100', title: '并发' })
    await Promise.all([
      a.writeArtifact({
        ref: { workspace: 'REQ-100', path: 'spec/spec.md' },
        content: 'v1',
        kind: 'spec',
        author: system,
      }),
      b.writeArtifact({
        ref: { workspace: 'REQ-100', path: 'spec/spec.md' },
        content: 'v2',
        kind: 'spec',
        author: system,
      }),
    ])
    const [record] = await b.listArtifacts('REQ-100')
    expect(record?.versions.map((v) => v.version)).toEqual([1, 2])
  })

  it('并发写入多个产物不会互相覆盖 manifest', async () => {
    const a = new FsWorkspaceStore(taktDir)
    const b = new FsWorkspaceStore(taktDir)
    await a.createRequirement({ id: 'REQ-200', title: '并发多文件' })
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? a : b).writeArtifact({
          ref: { workspace: 'REQ-200', path: `notes/n${i}.md` },
          content: `n${i}`,
          kind: 'other',
          author: system,
        }),
      ),
    )
    const records = await a.listArtifacts('REQ-200')
    expect(records.map((r) => r.path)).toEqual(Array.from({ length: 10 }, (_, i) => `notes/n${i}.md`))
    expect(records.every((r) => r.versions.length === 1)).toBe(true)
  })

  it('空白人工原因被拒绝，追溯 ID 只代表当前内容', async () => {
    const input = { ref: { workspace: 'REQ-001', path: 'spec.md' }, content: 'AC-001 TC-OLD', kind: 'spec' as const, author: system }
    for (const reason of ['', ' \t\n']) {
      await expect(store.writeArtifact({ ...input, author: { type: 'human', id: 'u' }, reason })).rejects.toThrow('reason')
    }
    await store.writeArtifact(input)
    await store.writeArtifact({ ...input, content: 'AC-002 TC-NEW' })
    expect((await store.listArtifacts('REQ-001'))[0]?.traceIds).toEqual(['AC-002', 'TC-NEW'])
  })

  it('同内容重写修复被修改或删除的最新副本，不新增版本', async () => {
    const input = { ref: { workspace: 'REQ-001', path: 'spec.md' }, content: 'original', kind: 'spec' as const, author: system }
    await store.writeArtifact(input)
    const live = path.join(store.dir('REQ-001'), 'spec.md')
    await writeFile(live, 'edited')
    expect((await store.writeArtifact(input)).version).toBe(1)
    expect(await readFile(live, 'utf8')).toBe('original')
    await rm(live)
    expect((await store.writeArtifact(input)).version).toBe(1)
    expect(await readFile(live, 'utf8')).toBe('original')
    expect((await store.listArtifacts('REQ-001'))[0]?.versions).toHaveLength(1)
    expect(await store.detectUntracked('REQ-001')).toEqual([])
  })

  it('未登记文件只允许无版本读取，元数据不能作为产物读取', async () => {
    await store.createRequirement({ id: 'REQ-001', title: 'read' })
    await writeFile(path.join(store.dir('REQ-001'), 'raw.txt'), 'raw')
    expect(await store.readArtifact({ workspace: 'REQ-001', path: 'raw.txt', version: 1 })).toBeUndefined()
    expect((await store.readArtifact({ workspace: 'REQ-001', path: 'raw.txt' }))?.toString()).toBe('raw')
    for (const name of ['manifest.json', 'requirement.json', 'comments.jsonl', 'MANIFEST.JSON']) {
      await expect(store.readArtifact({ workspace: 'REQ-001', path: name })).rejects.toThrow('元数据')
      await expect(store.writeArtifact({ ref: { workspace: 'REQ-001', path: name }, content: 'bad', kind: 'other', author: system })).rejects.toThrow('元数据')
    }
  })

  it('相对与绝对路径实例并发写入共享锁，dir 返回绝对路径', async () => {
    const other = new FsWorkspaceStore(path.relative(process.cwd(), taktDir))
    expect(path.isAbsolute(other.dir('REQ-001'))).toBe(true)
    const requirements = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? store : other).createRequirement({ title: `r${i}` })))
    expect(new Set(requirements.map((r) => r.id)).size).toBe(12)
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : other).writeArtifact({
      ref: { workspace: 'REQ-001', path: 'note.txt' }, content: `${i}`, kind: 'other', author: system,
    })))
    expect((await store.listArtifacts('REQ-001'))[0]?.versions).toHaveLength(12)
  })

  it('拒绝产物文件、父目录及 workspace 的符号链接逃逸', async () => {
    await store.createRequirement({ id: 'REQ-001', title: 'links' })
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'secret.txt'), 'untouched')
    await symlink(outside, path.join(store.dir('REQ-001'), 'escape'))
    await symlink(path.join(outside, 'secret.txt'), path.join(store.dir('REQ-001'), 'alias.txt'))
    for (const artifactPath of ['escape/secret.txt', 'escape/new.txt', 'alias.txt']) {
      const ref = { workspace: 'REQ-001', path: artifactPath }
      await expect(store.readArtifact(ref)).rejects.toThrow('符号链接')
      await expect(store.writeArtifact({ ref, content: 'bad', kind: 'other', author: system })).rejects.toThrow('符号链接')
    }
    const dir = store.dir('REQ-001')
    await rename(dir, `${dir}-saved`)
    await symlink(outside, dir)
    await expect(store.readArtifact({ workspace: 'REQ-001', path: 'secret.txt' })).rejects.toThrow('符号链接')
    await expect(store.writeArtifact({ ref: { workspace: 'REQ-001', path: 'secret.txt' }, content: 'bad', kind: 'other', author: system })).rejects.toThrow('符号链接')
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('untouched')
  })

  it('扫描不沿用 util 的默认忽略目录，损坏清单不当作空清单', async () => {
    await store.createRequirement({ id: 'REQ-001', title: 'scan' })
    await mkdir(path.join(store.dir('REQ-001'), 'dist'))
    await writeFile(path.join(store.dir('REQ-001'), 'dist/result.txt'), 'untracked')
    expect((await store.detectUntracked('REQ-001')).map((r) => r.path)).toEqual(['dist/result.txt'])
    await writeFile(path.join(store.dir('REQ-001'), 'manifest.json'), 'null')
    await expect(store.listArtifacts('REQ-001')).rejects.toThrow('结构不合法')
  })
})
