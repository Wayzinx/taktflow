import { ArrowUpRight, Pin, PinOff, X } from 'lucide-react'
import type { StewardContextRef } from '@taktflow/core'
import type { FocusTarget } from '../../components/steward/focus'
import { refPath } from '../../components/viz/ref'
import { Link } from '../../lib/router'
import { EntityPanel } from './entity'

const LABEL: Partial<Record<StewardContextRef['type'], string>> = { space: '空间', requirement: '需求', run: '运行', file: '文件' }

/**
 * 焦点面板（docs/design/28 §1）：默认跟随会话里最新出现的实体；📌 固定后不再跟随。
 * 面包屑是 空间 › 对象 › 节点，点前面的可以退回去；↗ 在新页打开完整页面。
 */
export function FocusPanel({ target, follow, onFollow, onTarget, onClose }: { target: FocusTarget; follow: boolean; onFollow: (v: boolean) => void; onTarget: (t: FocusTarget) => void; onClose: () => void }) {
  const space = target.ref.type === 'space' ? target.ref.id : target.ref.spaceId
  const path = refPath(target.node ? { type: 'node', spaceId: target.ref.spaceId, id: target.node, parent: target.ref.id } : target.ref)
  return (
    <aside className="solo-panel" aria-label="焦点面板">
      <header className="solo-panel-head">
        <nav className="solo-crumbs" aria-label="位置">
          {space && (
            <button type="button" className="solo-crumb" onClick={() => onTarget({ ref: { type: 'space', id: space, label: space } })} title="这个空间等你决定的事">
              {space}
            </button>
          )}
          {target.ref.type === 'file' && target.ref.parent && (
            <>
              <span aria-hidden>›</span>
              <button type="button" className="solo-crumb mono" onClick={() => onTarget({ ref: { type: 'requirement', spaceId: target.ref.spaceId, id: target.ref.parent!, label: target.ref.parent } })} title="需求">
                {target.ref.parent}
              </button>
              <span aria-hidden>›</span>
              <b className="solo-crumb mono truncate" title={target.ref.id}>
                {target.ref.label ?? target.ref.id}
              </b>
            </>
          )}
          {target.ref.type !== 'space' && target.ref.type !== 'file' && (
            <>
              <span aria-hidden>›</span>
              <button type="button" className="solo-crumb mono" disabled={!target.node} onClick={() => onTarget({ ref: target.ref })} title={LABEL[target.ref.type]}>
                {target.ref.id}
              </button>
            </>
          )}
          {target.node && (
            <>
              <span aria-hidden>›</span>
              <b className="solo-crumb mono truncate">{target.node}</b>
            </>
          )}
        </nav>
        <span className="solo-panel-tools">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-pressed={!follow} onClick={() => onFollow(!follow)} title={follow ? '固定：会话里出现新对象时不再切换' : '已固定，点一下恢复跟随'} aria-label={follow ? '固定' : '取消固定'}>
            {follow ? <Pin /> : <PinOff />}
          </button>
          {path && (
            <Link to={path} className="btn btn-ghost btn-icon btn-sm" title="打开完整页面" aria-label="打开完整页面">
              <ArrowUpRight />
            </Link>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} title="收起" aria-label="收起焦点面板">
            <X />
          </button>
        </span>
      </header>
      <div className="solo-panel-body">
        <EntityPanel key={`${target.ref.type}:${target.ref.spaceId}/${target.ref.id}`} target={target} onTarget={onTarget} />
      </div>
    </aside>
  )
}
