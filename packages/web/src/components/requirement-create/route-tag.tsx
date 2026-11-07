import { useEffect, useState } from 'react'
import { Route, Sparkles } from 'lucide-react'
import type { WorkflowSummary } from '@taktflow/core'
import { TIER_LABEL, TierGlyph } from '../tier-glyph'
import { estimateRoute, type RouteEstimate } from './estimate'
import { CheckRow, Tag } from './tag'

/** 输入停顿 600ms 后再算一次路由预估。 */
function useDebouncedEstimate(text: string, workflows?: WorkflowSummary[]) {
  const [est, setEst] = useState<RouteEstimate>()
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setPending(true)
    const t = setTimeout(() => {
      setEst(estimateRoute(text, workflows))
      setPending(false)
    }, 600)
    return () => clearTimeout(t)
  }, [text, workflows])
  return { est, pending }
}

/**
 * "流程"标签：默认自动。显示档位图形 + workflow 名，悬停 / 点开看一句理由；点开可以手动指定 workflow。
 * value 为空表示自动（交给服务端路由器）。
 */
export function RouteTag({ text, workflows, value, onChange }: { text: string; workflows?: WorkflowSummary[]; value?: string; onChange: (id?: string) => void }) {
  const { est, pending } = useDebouncedEstimate(text, workflows)
  const manual = value ? workflows?.find((w) => w.id === value) : undefined
  const shown = manual ? (
    <span className="rc-route-val">
      <span className="rc-route-mode">手动</span>
      {manual.title}
    </span>
  ) : est ? (
    <span className="rc-route-val" key={`${est.tier}-${est.workflowId}`}>
      <TierGlyph tier={est.tier} size={14} label={false} />
      <span className="rc-route-mode">自动</span>
      {est.workflowTitle ?? TIER_LABEL[est.tier].title}
    </span>
  ) : (
    <span className="rc-route-val">
      <span className="rc-route-mode">自动</span>写几句后给出建议
    </span>
  )
  return (
    <Tag icon={Route} label="流程" value={shown} onClear={manual ? () => onChange(undefined) : undefined} live={pending && !manual && text.trim().length > 3} width={340} title={est && !manual ? `${TIER_LABEL[est.tier].title}：${est.reason}` : '流程'}>
      {(close) => (
        <div className="rc-form">
          <div className={`rc-route-card${manual ? ' dim' : ''}`}>
            {est ? (
              <>
                <div className="rc-route-head">
                  <span className="rc-route-glyph">
                    <TierGlyph tier={est.tier} size={22} />
                  </span>
                  <span>
                    <strong>{TIER_LABEL[est.tier].title}</strong>
                    <span className="faint"> · {est.workflowTitle ?? est.workflowId ?? '按档位选流程'}</span>
                  </span>
                </div>
                <p className={`rc-route-reason${pending ? ' shimmer-text' : ''}`}>{est.reason}</p>
                <p className="rc-pop-foot">
                  <Sparkles aria-hidden className="rc-inline-icon" />
                  草稿预估；创建时路由器结合仓库改动面再确认一次。
                </p>
              </>
            ) : (
              <p className="rc-pop-empty">写下要做什么，停顿片刻就会给出档位和流程建议。</p>
            )}
          </div>
          <div className="rc-pop-sub">手动指定</div>
          <div className="rc-check-list">
            <CheckRow radio checked={!value} onChange={() => (onChange(undefined), close())} hint="推荐">
              自动（按改动形状选）
            </CheckRow>
            {(workflows ?? []).map((w) => (
              <CheckRow key={w.id} radio checked={value === w.id} onChange={() => (onChange(w.id), close())} hint={<span className="mono">{w.id}</span>}>
                {w.title}
              </CheckRow>
            ))}
          </div>
        </div>
      )}
    </Tag>
  )
}
