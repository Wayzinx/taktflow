import { safeLessonText } from './safety.js'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stringify } from 'yaml'
import type { LessonStore } from '../interfaces.js'
import type { Actor, Lesson } from '../types.js'
import { parseFrontmatter } from '../util/frontmatter.js'
import { assertNoSymlinks, isEnoent, readFileIfExists, writeFileAtomic } from '../store/fs-utils.js'
import { withFileLock } from '../store/file-lock.js'

export interface LessonAudit {
  type: 'lesson.created' | 'lesson.updated'
  id: string
  by: Actor
  reason: string
}

export function createLessonStore(options: { dir: string; audit?: (entry: LessonAudit) => void | Promise<void> }): LessonStore {
  const dir = resolve(options.dir)
  function file(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`经验 ID 不合法：${id}`)
    return join(dir, `${id}.md`)
  }
  async function get(id: string): Promise<Lesson | undefined> {
    const path = file(id)
    await assertNoSymlinks(dir, path)
    const bytes = await readFileIfExists(path)
    if (!bytes) return undefined
    try {
      const { data, body } = parseFrontmatter(bytes.toString('utf8'))
      const lesson = { ...data, body } as unknown as Lesson
      if (lesson.id !== id || typeof lesson.title !== 'string' || !lesson.trigger || !lesson.source
        || !['tentative', 'active', 'retired'].includes(lesson.status)
        || !lesson.stats || !Object.values(lesson.stats).every(value => Number.isInteger(value) && value >= 0)
        || !['recalled', 'helped', 'hurt'].every(key => key in lesson.stats)
        || !Number.isFinite(Date.parse(lesson.createdAt)) || !Number.isFinite(Date.parse(lesson.updatedAt))) {
        throw new Error('元数据不合法')
      }
      return lesson
    } catch (cause) { throw new Error(`无法读取经验：${path}`, { cause }) }
  }
  async function save(input: Omit<Lesson, 'createdAt' | 'updatedAt'> & { createdAt?: string }, by: Actor, reason: string): Promise<Lesson> {
    if (!safeLessonText(input.title, input.body)) throw new Error('经验不能绕过验证或修改工作流、门禁')
    if (!reason.trim()) throw new Error('修改经验必须填写 reason')
    const previous = await get(input.id)
    const now = new Date().toISOString()
    const lesson: Lesson = { ...input, status: input.userStated && input.status === 'tentative' ? 'active' : input.status,
      createdAt: previous?.createdAt ?? input.createdAt ?? now, updatedAt: now }
    const { body, ...meta } = lesson
    await writeFileAtomic(file(lesson.id), `---\n${stringify(meta)}---\n${body}`)
    await options.audit?.({ type: previous ? 'lesson.updated' : 'lesson.created', id: lesson.id, by, reason })
    return lesson
  }
  return {
    get,
    async list(filter) {
      let entries
      try { entries = await readdir(dir) } catch (error) { if (isEnoent(error)) return []; throw error }
      const lessons = await Promise.all(entries.filter(name => name.endsWith('.md')).sort().map(name => get(name.slice(0, -3))))
      return lessons.filter((lesson): lesson is Lesson => !!lesson && (!filter?.status || lesson.status === filter.status))
    },
    upsert(input, by, reason) { return withFileLock(file(input.id), () => save(input, by, reason)) },
    setStatus(id, status, by, reason) {
      return withFileLock(file(id), async () => {
        const lesson = await get(id)
        if (!lesson) throw new Error(`经验不存在：${id}`)
        return save({ ...lesson, status }, by, reason)
      })
    },
  }
}
