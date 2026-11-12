import { useState, type ReactNode } from 'react'
import { Bell, BellOff, Eye, Plus } from 'lucide-react'
import type { SpaceSummary, StewardPrefs, StewardRuntimeChoice } from '@taktflow/core'
import { Chips, Segmented, toast } from '../../components/ui'

type Watch = 'watch' | 'normal' | 'mute'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="stwp-field">
      <div className="stwp-field-label">
        <span>{label}</span>
        {hint && <span className="faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** 管家能用的 harness：按 runtime-choices 归并，任一组合可用就算可用，不可用时带上原因。 */
function harnessOptions(choices: StewardRuntimeChoice[]) {
  const byId = new Map<string, StewardRuntimeChoice[]>()
  for (const c of choices) byId.set(c.harness, [...(byId.get(c.harness) ?? []), c])
  return [...byId].map(([id, cs]) => ({ id, label: cs[0]!.harnessLabel, available: cs.some((c) => c.available), reason: cs.find((c) => !c.available && c.reason)?.reason }))
}

/** 管家偏好表单（docs/design/22 §1.7）：值由父组件持有，改动即时反映，保存在抽屉底部。 */
export function PrefsForm({ prefs, onChange, spaces, choices }: { prefs: StewardPrefs; onChange: (p: StewardPrefs) => void; spaces: SpaceSummary[]; choices: StewardRuntimeChoice[] }) {
  const [time, setTime] = useState('17:30')
  const set = (patch: Partial<StewardPrefs>) => onChange({ ...prefs, ...patch })
  const watchOf = (id: string): Watch => (prefs.watchedSpaces?.includes(id) ? 'watch' : prefs.mutedSpaces?.includes(id) ? 'mute' : 'normal')
  const setWatch = (id: string, w: Watch) =>
    set({
      watchedSpaces: [...(prefs.watchedSpaces ?? []).filter((x) => x !== id), ...(w === 'watch' ? [id] : [])],
      mutedSpaces: [...(prefs.mutedSpaces ?? []).filter((x) => x !== id), ...(w === 'mute' ? [id] : [])],
    })
  const addTime = () => {
    if (!/^\d{2}:\d{2}$/.test(time) || prefs.digestTimes.includes(time)) return
    set({ digestTimes: [...prefs.digestTimes, time].sort() })
  }
  const toggleNotify = async (on: boolean) => {
    if (on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const r = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission)
      if (r !== 'granted') return toast('浏览器没有允许通知', { tone: 'failed', body: '在浏览器地址栏左侧的站点设置里允许通知后再打开' })
    }
    set({ browserNotifications: on })
  }
  const def = choices.find((c) => c.isDefault)
  const harness = prefs.harness?.harness ?? def?.harness ?? 'native'
  const model = prefs.harness ? prefs.harness.model : def?.model
  const harnesses = harnessOptions(choices)
  const models = choices.filter((c) => c.harness === harness && c.model)

  return (
    <div className="stwp-form">
      <Field label="信任档位" hint="高风险操作永远需要你确认">
        <Segmented
          value={prefs.trust}
          onChange={(trust) => set({ trust })}
          ariaLabel="信任档位"
          options={[
            { value: 'confirm', label: '每次确认' },
            { value: 'auto-low', label: '低风险自动执行' },
          ]}
        />
        <p className="stwp-field-note">{prefs.trust === 'confirm' ? '每个写操作都先给你一份提案。' : '新建草稿、写记忆这类低风险且可撤销的操作直接执行，对话里显示"已执行，可撤销"。'}</p>
      </Field>

      <Field label="定时汇报" hint="工作日">
        <div className="stwp-row">
          <Chips items={prefs.digestTimes.map((t) => ({ id: t, label: t }))} onRemove={(t) => set({ digestTimes: prefs.digestTimes.filter((x) => x !== t) })} />
          <input className="input stwp-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="新增汇报时间" />
          <button type="button" className="btn btn-sm" onClick={addTime} disabled={prefs.digestTimes.includes(time)}>
            <Plus />
            添加
          </button>
        </div>
      </Field>

      <Field label="免打扰" hint="这段时间不推送，汇报照常进动态">
        <div className="stwp-row">
          <label className="stw-switch">
            <input type="checkbox" checked={!!prefs.quietHours} onChange={(e) => set({ quietHours: e.target.checked ? { from: '22:00', to: '08:00' } : undefined })} />
            <span>{prefs.quietHours ? '开' : '关'}</span>
          </label>
          {prefs.quietHours && (
            <>
              <input className="input stwp-time" type="time" value={prefs.quietHours.from} onChange={(e) => set({ quietHours: { ...prefs.quietHours!, from: e.target.value } })} aria-label="开始" />
              <span className="faint">到</span>
              <input className="input stwp-time" type="time" value={prefs.quietHours.to} onChange={(e) => set({ quietHours: { ...prefs.quietHours!, to: e.target.value } })} aria-label="结束" />
            </>
          )}
        </div>
      </Field>

      <Field label="空间" hint="关注的优先汇报；静音的不提醒">
        <ul className="stwp-spaces">
          {spaces.map((s) => (
            <li key={s.id} className="stwp-space">
              <span className="stwp-space-dot" style={{ background: s.color ?? 'var(--text-3)' }} aria-hidden />
              <span className="stwp-space-name truncate">{s.name}</span>
              <span className="faint mono truncate">{s.id}</span>
              <Segmented
                size="sm"
                value={watchOf(s.id)}
                onChange={(w) => setWatch(s.id, w)}
                ariaLabel={`${s.name} 的提醒`}
                options={[
                  { value: 'watch', label: '关注', icon: Eye },
                  { value: 'normal', label: '默认' },
                  { value: 'mute', label: '静音', icon: BellOff },
                ]}
              />
            </li>
          ))}
        </ul>
      </Field>

      <Field label="默认空间" hint="新建需求没指定空间时建在这里">
        <select className="select" value={prefs.defaultSpace ?? ''} onChange={(e) => set({ defaultSpace: e.target.value || undefined })}>
          <option value="">不指定（每次问我）</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.id}）
            </option>
          ))}
        </select>
      </Field>

      <Field label="管家用的 harness 与模型">
        <div className="stwp-row">
          <select className="select" value={harness} onChange={(e) => set({ harness: { harness: e.target.value } })} aria-label="harness">
            {(harnesses.length ? harnesses : [{ id: 'native', label: '内置', available: true, reason: undefined }]).map((h) => (
              // 不可用的也能看到原因；当前选中的不禁用，免得显示成空白
              <option key={h.id} value={h.id} disabled={!h.available && h.id !== harness} title={h.reason}>
                {h.label}
                {h.available ? '' : `（不可用${h.reason ? `：${h.reason}` : ''}）`}
              </option>
            ))}
          </select>
          <select className="select" value={model ?? ''} onChange={(e) => {
            const selected = models.find((m) => m.model === e.target.value)
            set({ harness: { harness, model: e.target.value || undefined, ...(selected?.provider ? { provider: selected.provider } : {}) } })
          }} aria-label="模型">
            <option value="">harness 默认</option>
            {models.map((m) => (
              <option key={`${m.provider ?? ''}/${m.model}`} value={m.model} disabled={!m.available && m.model !== model} title={m.reason}>
                {m.modelLabel ?? m.model}
                {m.provider ? ` · ${m.provider}` : ''}
                {m.available ? '' : '（不可用）'}
              </option>
            ))}
            {model && !models.some((m) => m.model === model) && <option value={model}>{model}</option>}
          </select>
        </div>
      </Field>

      <Field label="浏览器通知" hint="新风险与汇报弹系统通知">
        <label className="stw-switch">
          <input type="checkbox" checked={!!prefs.browserNotifications} onChange={(e) => void toggleNotify(e.target.checked)} />
          {prefs.browserNotifications ? <Bell aria-hidden /> : <BellOff aria-hidden />}
          <span>{prefs.browserNotifications ? '已开启' : '关闭'}</span>
        </label>
      </Field>
    </div>
  )
}
