import { globsOverlap } from '../util/glob.js'
import type { Lesson } from '../types.js'
import type { LessonRecall } from '../interfaces.js'

export const pathsIntersect = globsOverlap

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
