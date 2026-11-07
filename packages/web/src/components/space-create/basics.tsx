import { Check, CircleAlert } from 'lucide-react'
import type { SpaceSummary } from '@taktflow/core'
import { SpaceMark } from '../space-switcher'
import { SPACE_COLORS, checkId, checkName, slugify, type SpaceForm } from './model'

/** 颜色：8 个色块单选（/spaces 编辑对话框也用）。 */
export function ColorPicker({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  return (
    <div className="sc-colors" role="radiogroup" aria-label="空间颜色">
      {SPACE_COLORS.map((c) => (
        <button key={c.id} type="button" role="radio" aria-checked={value === c.value} aria-label={c.label} title={c.label} className="sc-swatch" style={{ background: c.value }} onClick={() => onChange(c.value)}>
          {value === c.value && <Check aria-hidden />}
        </button>
      ))}
    </div>
  )
}

/** 第 1 步：名称、id（自动生成，实时校验唯一）、描述、颜色。 */
export function StepBasics({ f, set, all, live }: { f: SpaceForm; set: (p: Partial<SpaceForm>) => void; all: SpaceSummary[]; live: SpaceSummary[] }) {
  const taken = new Set(all.map((s) => s.id))
  const id = checkId(f.id, all)
  const name = checkName(f.name, live)
  return (
    <div className="sc-step">
      <div className="sc-preview" aria-hidden>
        <SpaceMark space={{ name: f.name || '新', color: f.color }} size={40} />
        <div className="sc-preview-text">
          <strong className="truncate">{f.name || '新空间'}</strong>
          <span className="mono faint truncate">/s/{f.id || 'id'}</span>
        </div>
      </div>
      <label className="ov-field">
        <span className="ov-field-label">
          名称 <span className="ov-req">必填</span>
        </span>
        <input
          className={`input${name.msg && !name.ok ? ' sc-invalid' : ''}`}
          value={f.name}
          onChange={(e) => set({ name: e.target.value, ...(f.idTouched ? {} : { id: slugify(e.target.value, taken) }) })}
          placeholder="例如：会员中心"
          data-autofocus
          maxLength={40}
        />
        {name.msg && (
          <span className="sc-msg bad">
            <CircleAlert aria-hidden />
            {name.msg}
          </span>
        )}
      </label>
      <label className="ov-field">
        <span className="ov-field-label">
          id <span className="ov-field-hint">目录名与网址，创建后不能改</span>
        </span>
        <input className={`input mono${f.id && !id.ok ? ' sc-invalid' : ''}`} value={f.id} onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/\s+/g, '-'), idTouched: true })} placeholder="member-center" maxLength={40} spellCheck={false} />
        {(f.id || f.idTouched) && (
          <span className={`sc-msg${id.ok ? ' good' : ' bad'}`} key={`${id.ok}`}>
            {id.ok ? <Check aria-hidden /> : <CircleAlert aria-hidden />}
            {id.msg}
          </span>
        )}
      </label>
      <label className="ov-field">
        <span className="ov-field-label">
          描述 <span className="ov-field-hint">选填，一句话说清这条交付线</span>
        </span>
        <textarea className="textarea" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="例如：注册、积分与等级权益" />
      </label>
      <div className="ov-field">
        <span className="ov-field-label">颜色</span>
        <ColorPicker value={f.color} onChange={(color) => set({ color })} />
      </div>
    </div>
  )
}
