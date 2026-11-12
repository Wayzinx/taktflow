import type { ReactNode } from 'react'
import { termTitle, type Term as TermName } from '../../lib/glossary'
import './primitives.css'

/**
 * 术语（TF-041）：虚下划线，悬停显示 lib/glossary 里的一句话解释。容易看不懂的词第一次出现时包一下：
 *   <Term t="门禁" />、<Term t="职责">职责标签</Term>
 */
export function Term({ t, children }: { t: TermName; children?: ReactNode }) {
  return (
    <span className="term" title={termTitle(t)}>
      {children ?? t}
    </span>
  )
}
