import { Archive, CircleCheck, FlaskConical } from 'lucide-react'
import type { Lesson } from '@taktflow/core'
import type { StatusMeta } from '../../lib/status'

export type LessonStatus = Lesson['status']

export const LESSON_STATUS: Record<LessonStatus, StatusMeta & { hint: string }> = {
  active: { label: '启用', tone: 'success', icon: CircleCheck, hint: '命中触发条件就注入 prompt' },
  tentative: { label: '试用', tone: 'waiting', icon: FlaskConical, hint: '召回时参与对照组，帮助多于坑再启用' },
  retired: { label: '退役', tone: 'skipped', icon: Archive, hint: '文件保留，不再召回' },
}

export const LESSON_ORDER: LessonStatus[] = ['active', 'tentative', 'retired']

export const SOURCE_LABEL: Record<Lesson['source']['kind'], string> = { judge: '判决', review: '评审', human: '人工' }

/** 每个状态可以转去哪里，以及按钮文案。 */
export const TRANSITIONS: Record<LessonStatus, Array<{ to: LessonStatus; label: string }>> = {
  tentative: [
    { to: 'active', label: '启用' },
    { to: 'retired', label: '退役' },
  ],
  active: [
    { to: 'tentative', label: '退回试用' },
    { to: 'retired', label: '退役' },
  ],
  retired: [
    { to: 'tentative', label: '重新试用' },
    { to: 'active', label: '直接启用' },
  ],
}
