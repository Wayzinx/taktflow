import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLessonStore } from './store.js'
import type { Lesson } from '../types.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'takt-lessons-store-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const by = { type: 'human', id: 'owner' } as const
const input: Omit<Lesson, 'createdAt' | 'updatedAt'> = { id: 'lesson-one', title: '空值检查', body: '先检查输入。\n保留原有验证。', trigger: { roles: ['dev'], paths: ['src/**'], signatures: ['null'], categories: ['product_bug'] }, status: 'tentative', source: { kind: 'human' }, stats: { recalled: 0, helped: 0, hurt: 0 } }

it('frontmatter 保存完整元数据与正文，重开、筛选、更新和审计', async () => {
  const audit = vi.fn()
  const store = createLessonStore({ dir, audit })
  const saved = await store.upsert(input, by, '记录经验')
  expect(await createLessonStore({ dir }).get(input.id)).toEqual(saved)
  expect(await readFile(join(dir, `${input.id}.md`), 'utf8')).toContain('---\nid: lesson-one')
  expect(await store.list({ status: 'active' })).toEqual([])
  await store.setStatus(input.id, 'active', by, '确认有效')
  const edited = await store.upsert({ ...saved, status: 'active', body: '更新正文', createdAt: '2000-01-01T00:00:00.000Z' }, by, '修正文案')
  expect(edited.createdAt).toBe(saved.createdAt)
  expect((await store.list({ status: 'active' }))[0]?.body).toBe('更新正文')
  expect(audit.mock.calls.map(call => call[0])).toEqual([
    { type: 'lesson.created', id: input.id, by, reason: '记录经验' },
    { type: 'lesson.updated', id: input.id, by, reason: '确认有效' },
    { type: 'lesson.updated', id: input.id, by, reason: '修正文案' },
  ])
})

it('人明确写下的经验直接启用，仍可显式退役', async () => {
  const store = createLessonStore({ dir })
  expect((await store.upsert({ ...input, userStated: true }, by, '人工经验')).status).toBe('active')
  expect((await store.setStatus(input.id, 'retired', by, '过时')).status).toBe('retired')
  expect(await readFile(join(dir, `${input.id}.md`), 'utf8')).toContain('status: retired')
})

it('空目录与缺失经验可读，非法 ID、空原因、坏元数据和符号链接拒绝', async () => {
  const store = createLessonStore({ dir })
  expect(await createLessonStore({ dir: join(dir, 'missing') }).list()).toEqual([])
  expect(await store.get('missing')).toBeUndefined()
  await expect(store.upsert(input, by, ' ')).rejects.toThrow('reason')
  await expect(store.setStatus('missing', 'active', by, 'test')).rejects.toThrow('不存在')
  await expect(store.get('../outside')).rejects.toThrow('ID')
  await writeFile(join(dir, 'bad.md'), '---\nid: bad\n---\ninvalid')
  await expect(store.get('bad')).rejects.toThrow('无法读取经验')
  await symlink(join(dir, 'bad.md'), join(dir, 'link.md'))
  await expect(store.get('link')).rejects.toThrow('符号链接')
})
