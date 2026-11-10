import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { AutomationAction, AutomationConfig, AutomationEvent, ChannelView } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { Segmented, TagInput, ToggleChips, toast } from '../../components/ui'
import { describeCron, nextCron, parseCron } from '../../lib/cron'
import { fmtUpcoming } from '../../lib/format'
import { EditorDrawer, Field } from '../settings/runtime/shared'
import { ACTIONS, AUTOMATION_ID, CHANNEL_KINDS, EVENTS, PLACEHOLDERS, SCHEDULES } from './model'

type Kind = AutomationAction['kind']

/** 编辑 / 新建一个自动化（docs/design/30 §4）：什么时候 → 做什么 → 发到哪。 */
export function AutomationEditor({ open, onClose, initial, isNew, channels, takenIds, timezone, onSaved, onAddChannel }: { open: boolean; onClose: () => void; initial: AutomationConfig; isNew: boolean; channels: ChannelView[]; takenIds: string[]; timezone: string; onSaved: () => void; onAddChannel: () => void }) {
  const ds = useSource()
  const [d, setD] = useState(initial)
  const [openKey, setOpenKey] = useState(open)
  const [custom, setCustom] = useState(false)
  if (open !== openKey) {
    setOpenKey(open)
    if (open) {
      setD(structuredClone(initial))
      setCustom('schedule' in initial.trigger && !SCHEDULES.some((s) => s.cron === (initial.trigger as { schedule: string }).schedule))
    }
  }
  // ux-audit: ok 两个列表只用作下拉选项，空时下拉里有"选一个…"的占位
  const wq = useAsync((x) => (open ? x.workflows() : Promise.resolve([])), [open])
  // ux-audit: ok 同上
  const rq = useAsync((x) => (open ? x.requirements().catch(() => []) : Promise.resolve([])), [open])
  const text = useRef<HTMLTextAreaElement>(null)
  // 模板"新需求自动启动"没带 workflow：列表到了就先选第一个
  const firstWf = wq.data?.[0]?.id
  useEffect(() => {
    if (open && firstWf) setD((x) => (x.action.kind === 'start_workflow' && !x.action.workflowId ? { ...x, action: { ...x.action, workflowId: firstWf } } : x))
  }, [open, firstWf])

  const set = (patch: Partial<AutomationConfig>) => setD((x) => ({ ...x, ...patch }))
  const scheduled = 'schedule' in d.trigger
  const cron = scheduled ? (d.trigger as { schedule: string }).schedule : ''
  let cronError: string | undefined
  if (scheduled)
    try {
      parseCron(cron)
    } catch (e) {
      cronError = (e as Error).message
    }
  const next = scheduled && !cronError ? nextCron(cron) : undefined
  const kind = d.action.kind
  const picked = d.notify?.channels ?? []
  const needsChannel = kind !== 'start_workflow' && picked.length === 0
  const needsReq = scheduled && d.action.kind === 'start_workflow' && !d.action.requirementId
  const needsWf = d.action.kind === 'start_workflow' && !d.action.workflowId
  const idBad = isNew && (!AUTOMATION_ID.test(d.id) || takenIds.includes(d.id))
  const canSave = !!d.title.trim() && !idBad && !cronError && !needsChannel && !needsReq && !needsWf

  const setAction = (k: Kind) => {
    if (k === kind) return
    const action: AutomationAction = k === 'digest' ? { kind: 'digest' } : k === 'notify' ? { kind: 'notify', text: '' } : { kind: 'start_workflow', workflowId: wq.data?.[0]?.id ?? '' }
    set({ action })
  }
  const setEvent = (event: AutomationEvent) => setD((x) => ({ ...x, trigger: { event, ...('event' in x.trigger && x.trigger.filter ? { filter: x.trigger.filter } : {}) } }))
  const filter = 'event' in d.trigger ? d.trigger.filter : undefined
  const setFilter = (f: { workflowIds?: string[]; requirementIds?: string[] }) => {
    if (!('event' in d.trigger)) return
    const clean = { ...(f.workflowIds?.length ? { workflowIds: f.workflowIds } : {}), ...(f.requirementIds?.length ? { requirementIds: f.requirementIds } : {}) }
    set({ trigger: { event: d.trigger.event, ...(Object.keys(clean).length ? { filter: clean } : {}) } })
  }
  const insert = (token: string) => {
    if (d.action.kind !== 'notify') return
    const el = text.current
    const at = el?.selectionStart ?? d.action.text.length
    const v = d.action.text.slice(0, at) + token + d.action.text.slice(el?.selectionEnd ?? at)
    set({ action: { kind: 'notify', text: v } })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  const save = async (reason: string) => {
    const automation: AutomationConfig = { ...d, title: d.title.trim(), ...(kind === 'start_workflow' && !picked.length ? { notify: undefined } : {}) }
    await ds.saveAutomation(JSON.parse(JSON.stringify(automation)), reason)
    toast(isNew ? `已新建自动化「${automation.title}」` : `已保存「${automation.title}」`, { body: automation.enabled ? '马上生效，不用重启 serve。' : '已保存，但还是停用状态。' })
    onSaved()
  }

  return (
    <EditorDrawer open={open} onClose={onClose} title={isNew ? '新建自动化' : `编辑「${initial.title}」`} description="什么时候 → 做什么 → 发到哪。保存后写进空间配置，马上生效。" canSave={canSave} onSave={save} width={560}>
      <div className="au-ed-row">
        <Field label="名字" req>
          <input className="input" value={d.title} placeholder="例如：每日进展" onChange={(e) => set({ title: e.target.value })} data-autofocus />
        </Field>
        {isNew && (
          <Field label="id" req hint="小写字母、数字和 -">
            <input className={`input mono${idBad && d.id ? ' is-bad' : ''}`} value={d.id} onChange={(e) => set({ id: e.target.value.trim() })} />
            {idBad && d.id && <span className="rt-field-err">{takenIds.includes(d.id) ? '已经有这个 id 了' : '只能用小写字母、数字和 -，最长 40 个字符'}</span>}
          </Field>
        )}
      </div>

      <fieldset className="au-ed-sec">
        <legend>什么时候</legend>
        <Segmented<'schedule' | 'event'>
          size="sm"
          ariaLabel="触发方式"
          value={scheduled ? 'schedule' : 'event'}
          onChange={(v) => set({ trigger: v === 'schedule' ? { schedule: SCHEDULES[0]!.cron } : { event: 'run.failed' } })}
          options={[
            { value: 'schedule', label: '定时' },
            { value: 'event', label: '事件发生时' },
          ]}
        />
        {scheduled ? (
          <>
            <div className="au-presets" role="radiogroup" aria-label="常用时间">
              {SCHEDULES.map((s) => (
                <button key={s.cron} type="button" role="radio" aria-checked={!custom && cron === s.cron} className="ui-tchip pressable" onClick={() => (setCustom(false), set({ trigger: { schedule: s.cron } }))}>
                  {s.label}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={custom} className="ui-tchip pressable" onClick={() => setCustom(true)}>
                自定义 cron
              </button>
            </div>
            {custom && (
              <Field label="cron" hint="分 时 日 月 周，例如 0 9 * * 1-5">
                <input className={`input mono${cronError ? ' is-bad' : ''}`} value={cron} onChange={(e) => set({ trigger: { schedule: e.target.value } })} />
                {cronError ? <span className="rt-field-err">{cronError}</span> : <span className="rt-note">{describeCron(cron)}</span>}
              </Field>
            )}
            {next && (
              <p className="rt-note">
                下次：{fmtUpcoming(next.toISOString())}（{timezone}，按 serve 所在机器的时区；serve 没开着时错过的不补）
              </p>
            )}
          </>
        ) : (
          <>
            <div className="au-presets" role="radiogroup" aria-label="事件">
              {(Object.keys(EVENTS) as AutomationEvent[]).map((e) => (
                <button key={e} type="button" role="radio" aria-checked={'event' in d.trigger && d.trigger.event === e} className="ui-tchip pressable" onClick={() => setEvent(e)}>
                  {EVENTS[e].label}
                </button>
              ))}
            </div>
            {'event' in d.trigger && d.trigger.event !== 'requirement.created' && (wq.data?.length ?? 0) > 0 && (
              <Field label="只看这些流水线" hint="不选就是全部">
                <ToggleChips ariaLabel="只看这些 workflow" mono options={(wq.data ?? []).map((w) => ({ id: w.id, label: w.id, title: w.title }))} value={filter?.workflowIds ?? []} onChange={(workflowIds) => setFilter({ ...filter, workflowIds })} />
              </Field>
            )}
            {'event' in d.trigger && d.trigger.event !== 'requirement.created' && (
              <Field label="只看这些需求" hint="不填就是全部">
                <TagInput ariaLabel="只看这些需求" mono value={filter?.requirementIds ?? []} onChange={(requirementIds) => setFilter({ ...filter, requirementIds })} placeholder="REQ-001（回车添加）" />
              </Field>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="au-ed-sec">
        <legend>做什么</legend>
        <Segmented<Kind>
          size="sm"
          ariaLabel="动作"
          value={kind}
          onChange={setAction}
          options={(Object.keys(ACTIONS) as Kind[]).map((k) => ({ value: k, label: ACTIONS[k].label }))}
        />
        <p className="rt-note">{ACTIONS[kind].hint}</p>
        {d.action.kind === 'digest' && (
          <Field label="汇报范围">
            <select className="select" value={d.action.sinceHours ?? ''} onChange={(e) => set({ action: { kind: 'digest', ...(e.target.value ? { sinceHours: Number(e.target.value) } : {}) } })}>
              <option value="">上次成功发送以来（第一次是 24 小时）</option>
              <option value="24">最近 24 小时</option>
              <option value="168">最近 7 天</option>
            </select>
          </Field>
        )}
        {d.action.kind === 'notify' && (
          <Field label="消息" req>
            <textarea ref={text} className="textarea" rows={3} value={d.action.text} placeholder="{{requirement.title}} 的运行失败了：{{link}}" onChange={(e) => set({ action: { kind: 'notify', text: e.target.value } })} />
            <span className="au-tokens">
              {PLACEHOLDERS.map((p) => (
                <button key={p.token} type="button" className="ui-chip clickable pressable mono" onClick={() => insert(p.token)} title={`插入${p.label}`}>
                  {p.token}
                </button>
              ))}
            </span>
            <span className="rt-note">定时触发和手动执行时没有事件，需求 / 运行 / 节点的占位符会留空。</span>
          </Field>
        )}
        {d.action.kind === 'start_workflow' && (
          <div className="au-ed-row">
            <Field label="workflow" req>
              <select className="select mono" value={d.action.workflowId} onChange={(e) => set({ action: { ...(d.action as Extract<AutomationAction, { kind: 'start_workflow' }>), workflowId: e.target.value } })}>
                {!d.action.workflowId && <option value="">选一条流水线</option>}
                {(wq.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.id} · {w.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="需求" req={scheduled} hint={scheduled ? '定时触发要指定' : '不选就用事件里的需求'}>
              <select className="select" value={d.action.requirementId ?? ''} onChange={(e) => set({ action: { kind: 'start_workflow', workflowId: (d.action as { workflowId: string }).workflowId, ...(e.target.value ? { requirementId: e.target.value } : {}) } })}>
                <option value="">{scheduled ? '选一个需求' : '事件里的需求'}</option>
                {(rq.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} {r.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </fieldset>

      <fieldset className="au-ed-sec">
        <legend>
          发到哪{kind === 'start_workflow' ? <span className="faint">（可选：启动结果也发一条）</span> : <span className="ov-req">必填</span>}
        </legend>
        {channels.length ? (
          <ToggleChips ariaLabel="通知渠道" options={channels.map((c) => ({ id: c.id, label: `${CHANNEL_KINDS[c.kind].label} · ${c.title ?? c.id}`, title: c.url === 'missing' ? `还没有地址（${c.urlEnv}）` : undefined }))} value={picked} onChange={(ids) => set({ notify: { channels: ids } })} />
        ) : (
          <p className="rt-note">还没有通知渠道。</p>
        )}
        <button type="button" className="btn btn-sm btn-ghost au-add-channel" onClick={onAddChannel}>
          <Plus aria-hidden /> 添加渠道
        </button>
      </fieldset>

      <label className="au-check">
        <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>启用</span>
      </label>
    </EditorDrawer>
  )
}
