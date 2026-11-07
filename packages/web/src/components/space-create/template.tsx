import { Copy, FilePlus2, Workflow, Zap, type LucideIcon } from 'lucide-react'
import type { ServerInfo, SpaceSummary } from '@taktflow/core'
import { SpaceMark } from '../space-switcher'
import { COPY_PARTS, type SpaceForm, type StartKind } from './model'

const ICON: Record<StartKind, LucideIcon> = { blank: FilePlus2, standard: Workflow, quick: Zap, copy: Copy }
const FALLBACK: ServerInfo['spaceTemplates'] = [
  { id: 'blank', title: '空白', description: '只有目录结构，角色、workflow 都自己配' },
  { id: 'standard', title: '标准交付流水线', description: '需求理解 → 系分 → 测分 → 研发 → 测试 → 准出' },
  { id: 'quick', title: '快速修复', description: '短 spec → 实现 → 代码评审 → 交付校验' },
]

/** 第 2 步：起点四选一；复制已有空间时选来源并勾选要复制的部分。 */
export function StepTemplate({ f, set, templates, live }: { f: SpaceForm; set: (p: Partial<SpaceForm>) => void; templates?: ServerInfo['spaceTemplates']; live: SpaceSummary[] }) {
  const cards: Array<{ id: StartKind; title: string; description: string }> = [...(templates?.length ? templates : FALLBACK), { id: 'copy', title: '复制已有空间', description: '沿用一个空间的角色、技能、workflow 和设置' }]
  return (
    <div className="sc-step">
      <div className="sc-cards" role="radiogroup" aria-label="起点">
        {cards.map((c) => {
          const Icon = ICON[c.id]
          const on = f.start === c.id
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`sc-card pressable${on ? ' on' : ''}`}
              onClick={() => set({ start: c.id, ...(c.id === 'copy' && !f.copyFrom ? { copyFrom: live[0]?.id } : {}) })}
            >
              <span className="sc-card-icon">
                <Icon aria-hidden />
              </span>
              <span className="sc-card-title">
                {c.title}
                {c.id === 'standard' && <span className="sc-card-tag">推荐</span>}
              </span>
              <span className="sc-card-desc">{c.description}</span>
            </button>
          )
        })}
      </div>
      <div className="expand" data-open={String(f.start === 'copy')}>
        <div>
          <div className="sc-copy">
            <div className="ov-field">
              <span className="ov-field-label">从哪个空间复制</span>
              <div className="sc-src-list">
                {live.map((s) => (
                  <label key={s.id} className={`sc-src pressable${f.copyFrom === s.id ? ' on' : ''}`}>
                    <input type="radio" name="sc-copy-from" checked={f.copyFrom === s.id} onChange={() => set({ copyFrom: s.id })} />
                    <SpaceMark space={s} size={18} />
                    <span className="truncate">{s.name}</span>
                    <span className="mono faint">{s.id}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="ov-field">
              <span className="ov-field-label">
                复制哪些部分 <span className="ov-field-hint">需求、运行记录和知识库数据不会复制</span>
              </span>
              <div className="sc-parts">
                {COPY_PARTS.map((p) => (
                  <label key={p.id} className="sc-part pressable" title={p.hint}>
                    <input type="checkbox" checked={f.parts.includes(p.id)} onChange={(e) => set({ parts: e.target.checked ? [...f.parts, p.id] : f.parts.filter((x) => x !== p.id) })} />
                    <span>
                      {p.label}
                      <span className="sc-part-hint">{p.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
