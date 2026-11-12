import type { QualityStatus } from '@taktflow/core'
import type { Tone } from '../lib/status'

export interface QualityAlert {
  tone: Tone
  hint: string
  title: string
  to: string
}

/**
 * 质量日志断链或锚点落后时，总览读数格也要给醒目告警：缺陷、评测和拦截统计都是日志的读模型，
 * 链对不上时这些结论不能当成可信数据。返回 undefined 表示健康或状态还没读到。
 */
export function qualityAlertOf(s?: QualityStatus): QualityAlert | undefined {
  if (!s) return undefined
  if (!s.ok)
    return {
      tone: 'failed',
      hint: s.brokenAt !== undefined ? `日志从第 ${s.brokenAt} 条起断链，校验与拦截结论可能不可信` : '日志完整性校验未通过，校验与拦截结论可能不可信',
      title: '质量日志被改过、删过或文件不完整；点开查看处理步骤',
      to: '/settings?tab=quality',
    }
  if (s.anchorBehind)
    return {
      tone: 'waiting',
      hint: '日志完整，但校验锚点落后，结论尚未全部核对',
      title: '日志内容完整，只是校验标记（锚点）没跟上；点开可修复锚点',
      to: '/settings?tab=quality',
    }
  return undefined
}
