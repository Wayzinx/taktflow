import { useEffect, useState } from 'react'
import { Brain, SlidersHorizontal } from 'lucide-react'
import type { StewardPrefs } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { Drawer, ErrorState, SkeletonText, TabPanel, Tabs, toast } from '../../components/ui'
import { personalSteward } from '../../lib/space'
import { PrefsForm } from './prefs-form'

type Tab = 'prefs' | 'memory'

/**
 * 管家设置抽屉（docs/design/22 §1.7）：偏好（信任档位、汇报时间、免打扰、关注 / 静音空间、默认空间、harness 与模型、浏览器通知）
 * 与记忆（profile.md，人和管家共同编辑）。保存后 toast 带撤销（写回保存前的值）。
 */
export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ds = useSource()
  const shared = !personalSteward(location.pathname)
  const [tab, setTab] = useState<Tab>('prefs')
  const q = useAsync(
    async (d) => {
      if (!open) return undefined
      const [prefs, profile, spaces, choices, editable] = await Promise.all([
        d.stewardPrefs(), d.stewardProfile(), shared ? [] : d.spaces().catch(() => []), d.stewardRuntimeChoices(),
        shared ? d.me().then(me => me.member?.role === 'owner') : true,
      ])
      return { prefs, profile: profile.content, spaces, choices, editable }
    },
    [open, shared],
  )
  const [prefs, setPrefs] = useState<StewardPrefs>()
  const [profile, setProfile] = useState('')
  const [busy, setBusy] = useState(false)
  const [base, setBase] = useState<{ prefs: StewardPrefs; profile: string }>()
  useEffect(() => {
    if (!q.data) return
    setPrefs(q.data.prefs)
    setProfile(q.data.profile)
    setBase({ prefs: q.data.prefs, profile: q.data.profile })
  }, [q.data])

  const dirtyPrefs = !!prefs && !!base && JSON.stringify(prefs) !== JSON.stringify(base.prefs)
  const dirtyProfile = !!base && profile !== base.profile
  const dirty = dirtyPrefs || dirtyProfile

  const save = async () => {
    if (!prefs || !base || busy) return
    setBusy(true)
    const prev = base
    try {
      const [p, pr] = await Promise.all([dirtyPrefs ? ds.saveStewardPrefs(prefs) : Promise.resolve(prefs), dirtyProfile ? ds.saveStewardProfile(profile) : Promise.resolve({ content: profile })])
      setBase({ prefs: p, profile: pr.content })
      toast('已保存管家设置', {
        tone: 'success',
        body: [dirtyPrefs && '偏好', dirtyProfile && '记忆'].filter(Boolean).join('、') + '已更新，下一条回复起生效',
        undo: async () => {
          const [p2, pr2] = await Promise.all([ds.saveStewardPrefs(prev.prefs), ds.saveStewardProfile(prev.profile)])
          setPrefs(p2)
          setProfile(pr2.content)
          setBase({ prefs: p2, profile: pr2.content })
        },
      })
    } catch (e) {
      toast('保存失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="管家设置"
      description={shared ? '空间成员共享这份设置和记忆，负责人可以修改。' : '管家怎么替你做事、什么时候找你'}
      width={560}
      footer={
        <>
          {dirty && <span className="faint stwp-dirty">有未保存的修改</span>}
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (base) {
                setPrefs(base.prefs)
                setProfile(base.profile)
              }
              onClose()
            }}
          >
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy || !q.data?.editable} onClick={() => void save()}>
            {busy ? '正在保存' : '保存'}
          </button>
        </>
      }
    >
      <div className="stwp-drawer-tabs">
        <Tabs
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          tabs={[
            { id: 'prefs', label: '偏好', icon: SlidersHorizontal },
            { id: 'memory', label: '记忆', icon: Brain },
          ]}
        />
      </div>
      <div className="stwp-drawer-body">
        {q.error && !q.data ? (
          <ErrorState compact error={q.error} onRetry={q.reload} />
        ) : !q.data || !prefs ? (
          <SkeletonText lines={8} />
        ) : (
          <TabPanel key={tab}><fieldset disabled={!q.data.editable} style={{ border: 0, padding: 0, margin: 0 }}>
            {tab === 'prefs' ? (
              <PrefsForm shared={shared} prefs={prefs} onChange={setPrefs} spaces={q.data.spaces} choices={q.data.choices} />
            ) : (
              <div className="stwp-memory">
                <p className="stwp-field-note">
                  {shared ? '这是当前空间的团队记忆' : '这是管家对你的了解'}（<span className="mono">profile.md</span>）。你可以直接改；管家想记住什么时，会先提一个低风险提案让你确认。
                </p>
                <textarea className="textarea stwp-profile mono" value={profile} onChange={(e) => setProfile(e.target.value)} spellCheck={false} aria-label="profile.md" />
              </div>
            )}
          </fieldset></TabPanel>
        )}
      </div>
    </Drawer>
  )
}
