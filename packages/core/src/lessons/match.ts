import { matchGlob } from '../util/glob.js'
import type { Lesson } from '../types.js'
import type { LessonRecall } from '../interfaces.js'

// 对两个 glob 采用保守的静态前缀交集；具体路径则用已有 glob 匹配器。
export function pathsIntersect(a: string, b: string): boolean {
  const wildcard = /[*?[]/
  if (!wildcard.test(a) && !wildcard.test(b)) return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  if (!wildcard.test(a)) return matchGlob(b, a)
  if (!wildcard.test(b)) return matchGlob(a, b)
  const prefix = (value: string) => value.slice(0, value.search(wildcard))
  return prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a))
}

export function matches(lesson: Lesson, input: Parameters<LessonRecall['recall']>[0]): boolean {
  const { roles, paths, signatures, categories } = lesson.trigger
  const feedback = input.feedback ?? ''
  return (!roles?.length || !!input.role && roles.includes(input.role))
    && (!paths?.length || paths.some(path => input.paths.some(other => pathsIntersect(path, other))))
    && (!signatures?.length || signatures.some(signature => {
      try {
        const pattern = new RegExp(signature, 'i')
        return pattern.test(feedback) || pattern.test(feedback.replace(/\s+/g, ' '))
      } catch { return false }
    }))
    && (!categories?.length || categories.some(category => feedback.toLowerCase().includes(category)))
}
