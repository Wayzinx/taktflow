import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Defect, DefectDetail, Observation } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { Dialog, toast } from '../../components/ui'
import { OBS_KIND, OBS_SOURCE, SEVERITY } from '../eval/labels'

const EMPTY = { title: '', description: '', severity: 'major' as Defect['severity'], acs: '', link: '', evidence: '' }

const SEV_OF: Record<string, Defect['severity']> = { critical: 'critical', blocker: 'critical', major: 'major', minor: 'minor', nit: 'minor' }

/**
 * 录入缺陷：交付后发现的问题；关联 AC 让预检能查"有没有用例"。
 * from：从观察创建（docs/design/21 §4）——标题、描述、严重程度按第一条预填，观察 id 一起提交。
 */
export function DefectForm({ open, requirementId, from, onClose, onCreated }: { open: boolean; requirementId: string; from?: Observation[]; onClose: () => void; onCreated: (d: DefectDetail) => void }) {
  const ds = useSource()
  const [f, setF] = useState(EMPTY)
  useEffect(() => {
    if (!open || !from?.length) return
    const o = from[0]!
    setF({ ...EMPTY, title: o.title, description: from.map((x) => `【${OBS_SOURCE[x.source]}·${OBS_KIND[x.kind].label}】${x.title}${x.detail ? `：${x.detail}` : ''}`).join('\n'), severity: SEV_OF[from.find((x) => x.severity)?.severity ?? ''] ?? 'major' })
  }, [open, from])
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))
  const ok = f.title.trim().length >= 2 && f.description.trim().length >= 2 && !busy
  const dirty = f.title || f.description || f.acs || f.link || f.evidence
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    try {
      const acs = f.acs.split(/[\s,，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
      const d = await ds.reportDefect(requirementId, {
        title: f.title.trim(),
        description: f.description.trim(),
        severity: f.severity,
        acs: acs.length ? acs : undefined,
        links: f.link.trim() ? [{ type: /meego/.test(f.link) ? 'meego' : /feishu|larksuite/.test(f.link) ? 'feishu' : 'url', url: f.link.trim() }] : undefined,
        evidence: f.evidence.trim() ? f.evidence.split('\n').map((s) => s.trim()).filter(Boolean) : undefined,
        observations: from?.length ? from.map((o) => o.id) : undefined,
      })
      toast(`已录入 ${d.id}`, { body: '可以开始归因：先做确定性预检，再由独立的 auditor 沿溯源链给出候选。', tone: 'success' })
      setF(EMPTY)
      invalidate()
      onCreated(d)
    } catch (e) {
      toast('录入失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!dirty}
      title={from?.length ? `从 ${from.length} 条观察创建缺陷` : '录入缺陷'}
      description={from?.length ? '观察本身不可变；缺陷记有效性与处理状态，之后可以合并或改判。' : '交付后发现的问题，同时记一条人工缺陷单观察。也可以用 takt defect report 录入。'}
      footer={
        <>
          <button className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-sm btn-primary" disabled={!ok} aria-busy={busy} onClick={submit}>
            {busy && <LoaderCircle className="spin" aria-hidden />}
            录入
          </button>
        </>
      }
    >
      <div className="ev-form">
        {from?.length ? (
          <ul className="df-from">
            {from.map((o) => (
              <li key={o.id}>
                <span className="df-obs-src">{OBS_SOURCE[o.source]}</span>
                <span className="truncate">{o.title}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="ev-field">
          <span className="ev-label">标题</span>
          <input className="input" value={f.title} onChange={set('title')} placeholder="一句话说清现象，例如：地址含逗号时 CSV 列错位" autoFocus />
        </label>
        <label className="ev-field">
          <span className="ev-label">描述</span>
          <textarea className="textarea" rows={4} value={f.description} onChange={set('description')} placeholder="在哪发现、复现步骤、期望与实际" />
        </label>
        <div className="ev-grid">
          <div className="ev-field">
            <span className="ev-label">严重程度</span>
            <div className="df-sev" role="radiogroup" aria-label="严重程度">
              {(Object.keys(SEVERITY) as Array<Defect['severity']>).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={f.severity === s} className={`df-sev-opt${f.severity === s ? ' on' : ''}`} onClick={() => setF((x) => ({ ...x, severity: s }))}>
                  <i className={`df-sev-dot df-sev-${s}`} aria-hidden />
                  {SEVERITY[s].label}
                </button>
              ))}
            </div>
          </div>
          <label className="ev-field">
            <span className="ev-label">关联验收标准</span>
            <input className="input mono" value={f.acs} onChange={set('acs')} placeholder="AC-1, AC-2" />
          </label>
        </div>
        <label className="ev-field">
          <span className="ev-label">外部缺陷单（可选）</span>
          <input className="input mono" value={f.link} onChange={set('link')} placeholder="https://meego…/issue/4821" />
        </label>
        <label className="ev-field">
          <span className="ev-label">证据（可选，每行一条）</span>
          <textarea className="textarea mono" rows={2} value={f.evidence} onChange={set('evidence')} placeholder="uat/export-1105.csv 第 37 行" />
        </label>
      </div>
    </Dialog>
  )
}
