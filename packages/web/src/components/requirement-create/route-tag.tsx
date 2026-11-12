import { useEffect, useState } from 'react'
import { Info, Route } from 'lucide-react'
import type { WorkflowSummary } from '@taktflow/core'
import { useSource } from '../../api'
import { Link } from '../../lib/router'
import { TIER_LABEL, TierGlyph } from '../tier-glyph'
import { estimateRoute, routePreviewFailure, type RouteEstimate } from './estimate'
import { CheckRow, Tag } from './tag'

/**
 * 输入停顿 600ms 后预估路由：走服务端同一个路由器（POST /route/preview），保证"对话框里看到的 = 创建后的结果"；
 * 接口不可用（旧服务端、离线）时退回本地规则。409（没有流水线 / 没有接得住的档位）是配置问题，原因照实展示。
 */
function useDebouncedEstimate(text: string, workflows?: WorkflowSummary[]) {
  const ds = useSource()
  const [est, setEst] = useState<RouteEstimate>()
  const [failure, setFailure] = useState<string>()
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let live = true
    setPending(true)
    const t = setTimeout(() => {
      const local = () => estimateRoute(text, workflows)
      const done = (v: RouteEstimate | undefined, reason?: string) => {
        if (!live) return
        setEst(v)
        setFailure(reason)
        setPending(false)
      }
      if (text.trim().length < 4) return done(undefined)
      ds.routePreviewDraft({ text })
        .then((r) => done({ tier: r.tier, workflowId: r.workflowId, workflowTitle: workflows?.find((w) => w.id === r.workflowId)?.title, reason: r.reason, source: 'server' }))
        .catch((e: unknown) => {
          const reason = routePreviewFailure(e)
          if (reason) done(undefined, reason)
          else done(local())
        })
    }, 600)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [ds, text, workflows])
  return { est, failure, pending }
}

/**
 * "流程"标签：默认自动。显示档位图形 + workflow 名，悬停 / 点开看一句理由；点开可以手动指定 workflow。
 * value 为空表示自动（交给服务端路由器）。
 */
export function RouteTag({ text, workflows, value, onChange }: { text: string; workflows?: WorkflowSummary[]; value?: string; onChange: (id?: string) => void }) {
  const { est, failure, pending } = useDebouncedEstimate(text, workflows)
  const noWorkflows = !!workflows && workflows.length === 0
  const manual = value ? workflows?.find((w) => w.id === value) : undefined
  const shown = noWorkflows ? (
    <span className="rc-route-val rc-route-none">
      这个空间还没有流水线 · <Link to="/workflows">去创建</Link>
    </span>
  ) : failure ? (
    <span className="rc-route-val rc-route-none" title={failure}>
      路由失败 · {failure}
    </span>
  ) : manual ? (
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
    <Tag icon={Route} label="流程" value={shown} onClear={manual ? () => onChange(undefined) : undefined} live={pending && !manual && text.trim().length > 3} width={340} title={noWorkflows ? '这个空间还没有流水线' : failure ?? (est && !manual ? `${TIER_LABEL[est.tier].title}：${est.reason}` : '流程')}>
      {(close) => (
        <div className="rc-form">
          <div className={`rc-route-card${manual ? ' dim' : ''}`}>
            {noWorkflows ? (
              <p className="rc-pop-empty">
                这个空间还没有流水线，先去 <Link to="/workflows" onClick={close}>流水线页</Link> 新建或从模板导入。
              </p>
            ) : failure ? (
              <p className="rc-pop-empty">路由预览失败：{failure}。可以先去 <Link to="/workflows" onClick={close}>流水线页</Link> 检查配置。</p>
            ) : est ? (
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
                  <Info aria-hidden className="rc-inline-icon" />
                  {est.source === 'server'
                    ? '服务端路由器的预估，创建时以实际路由结果为准（结果在创建提示里）。'
                    : '按关键词的本地预估，不是路由器结论；创建时由服务端路由器决定（结果在创建提示里）。'}
                </p>
              </>
            ) : (
              <p className="rc-pop-empty">写下要做什么，停顿片刻就会给出档位和流程建议。</p>
            )}
          </div>
          {!noWorkflows && (
            <>
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
            </>
          )}
        </div>
      )}
    </Tag>
  )
}
