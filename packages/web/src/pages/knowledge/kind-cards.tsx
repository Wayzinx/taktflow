import type { KnowledgeKindInfo } from '@taktflow/core'
import { Lock } from 'lucide-react'
import { useStagger } from '../../components/ui'
import { KindGlyph } from './card'
import { intentLabel } from './meta'

/** 类型卡片：写明"适合回答什么"和一个例子；不可用的类型说明原因（例如缺插件）。 */
export function KindCards({ kinds, value, onPick, compact }: { kinds: KnowledgeKindInfo[]; value?: string; onPick: (k: KnowledgeKindInfo) => void; compact?: boolean }) {
  const st = useStagger(kinds.length)
  return (
    <div className={`kb-kinds${compact ? ' compact' : ''}`} role="radiogroup" aria-label="知识库类型">
      {kinds.map((k, i) => {
        const s = st(i)
        return (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={value === k.kind}
            disabled={!k.available}
            className={`kb-kind pressable${value === k.kind ? ' selected' : ''} ${s.className ?? ''}`}
            style={s.style}
            onClick={() => onPick(k)}
            title={k.available ? undefined : k.reason}
          >
            <span className="kb-kind-head">
              <KindGlyph kind={k.kind} size={30} />
              <strong>{k.title}</strong>
              {!k.available && <Lock className="kb-kind-lock" aria-label="暂不可用" />}
            </span>
            <span className="kb-kind-sum">{k.available ? k.summary : k.reason}</span>
            {!compact && k.example && <span className="kb-kind-eg">例：{k.example}</span>}
            {!compact && (
              <span className="kb-kind-intents">
                {k.intents.map((x) => (
                  <span key={x} className="kb-tag">
                    {intentLabel(x)}
                  </span>
                ))}
                {!k.needsBuild && <span className="kb-tag quiet">无需构建</span>}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
