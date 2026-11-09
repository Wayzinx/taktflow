
import { useLocation } from '../../lib/router'
import { askSteward } from '../../lib/ui-store'
import { BeeGlyph } from '../../components/identity'

/**
 * 设置页"让管家帮我改"（D 组）：没有写接口的配置（harness、模型、知识源绑定以外的文件项）不教人改文件，
 * 而是把要改的东西交给管家：管家出变更提案（diff），人批准后才写入。
 *   <StewardEditButton ask="帮我给 reviewer 角色换成 claude-opus" />
 *   <StewardEditNote what="模型与 harness" ask="帮我加一个模型：" />
 */
export function StewardEditButton({ ask, label = '让管家帮我改', size = 'sm', ghost }: { ask: string; label?: string; size?: 'sm' | 'md'; ghost?: boolean }) {
  const { spaceId } = useLocation()
  return (
    <button
      type="button"
      className={`btn${size === 'sm' ? ' btn-sm' : ''}${ghost ? ' btn-ghost' : ''}`}
      onClick={() => askSteward(ask, spaceId ? [{ type: 'space', id: spaceId, label: spaceId }] : undefined)}
      title="管家会给出一份变更提案，你确认后才写入"
    >
      <BeeGlyph aria-hidden />
      {label}
    </button>
  )
}

/** 一行说明 + 按钮：放在只读区块的底部或空状态里。 */
/** text 不给时是"还不能在页面上直接改"的说法；能直接改的页面给一句自己的说法。 */
export function StewardEditNote({ what, ask, text }: { what: string; ask: string; text?: string }) {
  return (
    <div className="steward-edit-note">
      <BeeGlyph aria-hidden className="steward-edit-icon" />
      <span className="steward-edit-text">
        {text ?? `${what}还不能在页面上直接改。告诉管家想怎么改，它会出一份变更提案，你确认后才生效。`}
      </span>
      <StewardEditButton ask={ask} />
    </div>
  )
}
