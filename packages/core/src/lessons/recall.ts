import type { LessonRecall, LessonStore } from '../interfaces.js'
import type { Lesson, TaktConfig } from '../types.js'
import { sha256 } from '../util/hash.js'
import { estimateTokens } from '../util/tokens.js'
import { withLock } from '../store/locks.js'
import { matches } from './match.js'

const actor = { type: 'system', id: 'lessons' } as const
const storeKeys = new WeakMap<LessonStore, string>()
let storeSequence = 0

export function createLessonRecall({ store, config = {} }: { store: LessonStore; config?: TaktConfig['lessons'] }): LessonRecall {
  if (!storeKeys.has(store)) storeKeys.set(store, `lesson-recall-${++storeSequence}`)
  const key = storeKeys.get(store)!
  const recorded = new Set<string>()
  const held = new Map<string, Set<string>>()
  return {
    async recall(input) {
      if (config.enabled === false) return { lessons: [], holdout: false, text: '', tokens: 0 }
      const control = Number.parseInt(sha256(input.runId + input.nodeId).slice(0, 8), 16) % 100 < (config.holdoutPercent ?? 15)
      const candidates = (await store.list()).filter(lesson => lesson.status !== 'retired' && matches(lesson, input))
        .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active')
          || (b.stats.helped - b.stats.hurt) - (a.stats.helped - a.stats.hurt) || a.id.localeCompare(b.id))
      const lessons: Lesson[] = []
      const chunks: string[] = []
      let budgetText = ''
      const heldIds = new Set<string>()
      for (const lesson of candidates) {
        if (lessons.length >= (config.maxRecall ?? 3)) break
        const chunk = `### ${lesson.title}\n${lesson.body}`
        const next = [budgetText, chunk].filter(Boolean).join('\n\n')
        // 不截断修复建议的正文，超出预算时跳过整条，避免留下半条指令。
        if (estimateTokens(next) > (config.maxTokens ?? 600)) continue
        budgetText = next
        lessons.push(lesson)
        if (control && lesson.status === 'tentative' && !lesson.userStated) heldIds.add(lesson.id)
        else chunks.push(chunk)
      }
      held.set(JSON.stringify([input.runId, input.nodeId]), heldIds)
      const text = chunks.join('\n\n')
      return { lessons, holdout: heldIds.size > 0 && chunks.length === 0, text, tokens: estimateTokens(text) }
    },
    async record(input) {
      return withLock(key, async () => {
        const changes: Awaited<ReturnType<LessonRecall['record']>> = []
        for (const id of new Set(input.ids)) {
          const once = JSON.stringify([input.runId, input.nodeId, id])
          if (recorded.has(once)) continue
          const lesson = await store.get(id)
          if (!lesson) continue
          const holdout = held.get(JSON.stringify([input.runId, input.nodeId]))?.has(id)
            ?? (input.holdout && lesson.status === 'tentative' && !lesson.userStated)
          const stats = { ...lesson.stats, recalled: lesson.stats.recalled + 1 }
          if (input.outcome === 'helped') stats.helped++
          else if (!holdout) stats.hurt++
          const status = stats.hurt >= 2 ? 'retired'
            : lesson.status === 'tentative' && (stats.helped >= 5 || lesson.userStated) ? 'active' : lesson.status
          const reason = `首次执行${input.outcome === 'helped' ? '成功' : '失败'}${holdout ? '（对照组）' : ''}`
          await store.upsert({ ...lesson, stats, status }, actor, reason)
          recorded.add(once)
          if (status !== lesson.status) changes.push({ id, status, reason, stats })
        }
        return changes
      })
    },
  }
}
