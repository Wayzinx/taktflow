import { useRef, useState } from 'react'
import { Boxes, Cpu, KeyRound, MoreHorizontal, Pencil, Plus, Power, Route, ServerOff, Settings2, Trash2 } from 'lucide-react'
import type { HarnessInfo, ModelInfo, RuntimeConfig, RuntimeTestResult } from '@taktflow/core'
import { useAsync } from '../../api'
import { StatCard, StatStrip } from '../../components/stat-card'
import { CountUp, EmptyState, ErrorState, Menu, ReasonDialog, Segmented, Skeleton, toast, useFlashRows, useStagger } from '../../components/ui'
import { StewardEditNote } from './ask-steward'
import { CAPABILITIES } from '../../lib/capabilities'
import { HarnessCard } from './harness-card'
import { CustomHarnessDrawer, OverrideDrawer } from './runtime/harness-edit'
import { ModelsCard } from './runtime/models'
import { ProvidersCard } from './runtime/providers'
import { RoutingCard } from './runtime/routing'
import { TestButton, TestOutcome, useRuntime, type RuntimeApi } from './runtime/shared'
import './models.css'
import './runtime/runtime.css'

/** 整数读数：过渡中途也按整数显示（CountUp 默认格式会在中途露出小数）。 */

type Filter = 'all' | 'available' | 'unavailable'

function Stats({ harnesses, models, cfg }: { harnesses?: HarnessInfo[]; models?: ModelInfo[]; cfg?: RuntimeConfig }) {
  if (!harnesses || !models) {
    return (
      <StatStrip label="运行环境读数">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat-cell stat-skeleton">
            <Skeleton w={72} h={11} />
            <Skeleton w={56} h={26} />
            <Skeleton w={140} h={10} />
          </div>
        ))}
      </StatStrip>
    )
  }
  const live = harnesses.filter((h) => !h.override?.disabled)
  const available = live.filter((h) => h.available)
  const down = live.filter((h) => !h.available)
  const local = cfg ? Object.values(cfg.keys).filter((k) => k === 'local').length : 0
  const missingKeys = models.filter((m) => !m.keyPresent)
  const providers = new Set(models.map((m) => m.provider))
  const protocols = new Set(models.map((m) => m.protocol))
  const bound = harnesses.filter((h) => h.roles.length > 0)
  return (
    <StatStrip label="运行环境读数">
      <StatCard
        label="Harness 可用"
        icon={<Cpu />}
        tone={down.length ? 'var(--st-failed)' : undefined}
        value={
          <>
            <CountUp value={available.length} />
            <span className="stat-unit">/ {live.length}</span>
          </>
        }
        foot={down.length ? <>不可用：{down.map((h) => h.id).join(' · ')}</> : '全部可用'}
      />
      <StatCard label="模型" icon={<Boxes />} value={<CountUp value={models.length} />} foot={<><b>{providers.size}</b> 个 provider · <b>{protocols.size}</b> 种协议</>} />
      <StatCard
        label="密钥已配置"
        icon={<KeyRound />}
        tone={missingKeys.length ? 'var(--st-waiting)' : undefined}
        value={
          <>
            <CountUp value={models.length - missingKeys.length} />
            <span className="stat-unit">/ {models.length}</span>
          </>
        }
        foot={missingKeys.length ? <>缺少：{[...new Set(missingKeys.map((m) => m.provider))].join(' · ')}</> : local ? <><b>{local}</b> 个存在本机密钥库 · 其余来自环境变量</> : '只检查密钥在不在，不读取值'}
      />
      <StatCard
        label="默认路由"
        icon={<Route />}
        value={<CountUp value={bound.reduce((s, h) => s + h.roles.length, 0)} />}
        foot={bound.length ? bound.map((h) => `${h.id} ${h.roles.length}`).join(' · ') : '还没有角色指定默认 harness'}
      />
    </StatStrip>
  )
}

function CapLegend() {
  return (
    <div className="cap-legend" aria-label="能力图例">
      {CAPABILITIES.map(({ key, label, icon: Icon }) => (
        <span key={key}>
          <Icon strokeWidth={2} />
          {label}
        </span>
      ))}
    </div>
  )
}

function HarnessSkeleton() {
  return (
    <div className="harness-grid">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card harness-card">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Skeleton w={36} h={36} r={10} />
            <div style={{ flex: 1 }}>
              <Skeleton w="50%" h={13} />
              <Skeleton w="30%" h={10} style={{ marginTop: 8 }} />
            </div>
          </div>
          <Skeleton h={30} style={{ marginTop: 22 }} />
          <Skeleton w="60%" h={10} style={{ marginTop: 20 }} />
        </div>
      ))}
    </div>
  )
}

/** 卡片上的操作：测试（探测 / ACP 握手）+ 菜单（内置：设置、停用；自加的：编辑、删除）。 */
function HarnessActions({ h, rt, onResult, onSettings, onEdit, onRemove }: { h: HarnessInfo; rt: RuntimeApi; onResult: (r: RuntimeTestResult | undefined) => void; onSettings: () => void; onEdit: () => void; onRemove: () => void }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [toggling, setToggling] = useState(false)
  const disabled = Boolean(h.override?.disabled)
  const builtin = !h.custom && h.source !== 'plugin'
  return (
    <>
      {!disabled && <TestButton target={{ kind: 'harness', id: h.id }} onResult={onResult} ghost />}
      {rt.cfg && (h.custom || builtin) && (
        <>
          <button ref={btn} type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`${h.displayName} 的更多操作`} onClick={() => setOpen(true)}>
            <MoreHorizontal />
          </button>
          <Menu
            open={open}
            onClose={() => setOpen(false)}
            anchor={btn}
            placement="bottom-end"
            items={
              h.custom
                ? [
                    { id: 'edit', label: '编辑', icon: Pencil, onSelect: onEdit },
                    { id: 'del', label: '删除', icon: Trash2, danger: true, separator: true, onSelect: onRemove },
                  ]
                : [
                    { id: 'set', label: '可执行文件与环境变量', icon: Settings2, onSelect: onSettings },
                    { id: 'toggle', label: disabled ? '在本空间重新启用' : '在本空间停用', icon: Power, separator: true, danger: !disabled, onSelect: () => setToggling(true) },
                  ]
            }
          />
          <ReasonDialog
            open={toggling}
            onClose={() => setToggling(false)}
            risk={disabled ? 'write' : 'dangerous'}
            title={disabled ? `重新启用 ${h.displayName}` : `在本空间停用 ${h.displayName}`}
            description={
              disabled
                ? '启用后路由和探测都能看到它。'
                : h.roles.length
                  ? `还有角色在用它：${h.roles.join('、')}。先把这些角色改到别的 harness，否则保存会被拒绝。`
                  : '停用后路由和探测都看不到它；正在跑的节点不受影响。'
            }
            confirmLabel={disabled ? '启用' : '停用'}
            onSubmit={async (reason) => {
              const o = { ...rt.cfg!.harnessOverrides[h.id] }
              if (disabled) delete o.disabled
              else o.disabled = true
              await rt.patch({ harnessOverrides: { [h.id]: Object.keys(o).length ? o : null } }, reason)
              toast(disabled ? `${h.displayName} 已重新启用` : `${h.displayName} 已在本空间停用`)
            }}
          />
        </>
      )}
    </>
  )
}

export function RuntimeTab() {
  const hq = useAsync((ds) => ds.harnesses(), [])
  const mq = useAsync((ds) => ds.models(), [])
  const rt = useRuntime()
  const [filter, setFilter] = useState<Filter>('all')
  const [results, setResults] = useState<Record<string, RuntimeTestResult | undefined>>({})
  const [override, setOverride] = useState<{ open: boolean; h?: HarnessInfo }>({ open: false })
  const [custom, setCustom] = useState<{ open: boolean; editing?: string }>({ open: false })
  const [removing, setRemoving] = useState<HarnessInfo>()

  const hs = hq.data
  const shown = hs?.filter((h) => filter === 'all' || (filter === 'available' ? h.available : !h.available)) ?? []
  const downCount = hs?.filter((h) => !h.available).length ?? 0
  const st = useStagger(shown.length)
  const flash = useFlashRows(shown.map((h) => h.id))

  return (
    <>
      <Stats harnesses={hs} models={mq.data} cfg={rt.cfg} />
      <section className="settings-section">
        <div className="section-head">
          <h2 className="section-title">Harness</h2>
          {hs && <span className="faint num">{hs.length}</span>}
          <span className="spacer" />
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: '全部' },
              { value: 'available', label: '可用' },
              { value: 'unavailable', label: '不可用', count: downCount || undefined },
            ]}
            size="sm"
            ariaLabel="按可用性筛选"
          />
          {rt.cfg && (
            <button type="button" className="btn btn-sm" onClick={() => setCustom({ open: true })}>
              <Plus aria-hidden /> 添加 harness
            </button>
          )}
        </div>
        <CapLegend />
        {hq.error && !hs ? (
          <div className="card">
            <ErrorState error={hq.error} onRetry={hq.reload} />
          </div>
        ) : !hs ? (
          <HarnessSkeleton />
        ) : shown.length === 0 ? (
          <div className="card">
            <EmptyState
              compact
              icon={ServerOff}
              title={filter === 'unavailable' ? '所有 harness 都可用' : '没有符合条件的 harness'}
              body={filter === 'unavailable' ? '每个 harness 都能正常调起。' : '接入一个支持 ACP 的 agent，或一个声明式 CLI。'}
              action={filter !== 'all' ? <button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button> : rt.cfg ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setCustom({ open: true })}>添加 harness</button> : undefined}
            />
          </div>
        ) : (
          <div className="harness-grid">
            {shown.map((h, i) => {
              const sx = st(i)
              return (
                <div key={h.id} className={[sx.className, flash(h.id)].filter(Boolean).join(' ') || undefined} style={sx.style}>
                  <HarnessCard
                    h={h}
                    below={results[h.id] && <TestOutcome r={results[h.id]!} />}
                    actions={
                      <HarnessActions
                        h={h}
                        rt={rt}
                        onResult={(r) => setResults((m) => ({ ...m, [h.id]: r }))}
                        onSettings={() => setOverride({ open: true, h })}
                        onEdit={() => setCustom({ open: true, editing: h.id })}
                        onRemove={() => setRemoving(h)}
                      />
                    }
                  />
                </div>
              )
            })}
          </div>
        )}
      </section>

      {rt.error && !rt.cfg ? (
        <section className="settings-section">
          <div className="card">
            <ErrorState error={rt.error} onRetry={rt.reload} />
          </div>
        </section>
      ) : rt.cfg ? (
        <>
          <section className="settings-section">
            <RoutingCard rt={rt} harnesses={hs ?? []} />
          </section>
          <section className="settings-section">
            <ProvidersCard rt={rt} />
          </section>
        </>
      ) : null}

      <section className="settings-section">
        <ModelsCard rt={rt} models={mq.data} error={mq.error} reload={mq.reload} />
        <StewardEditNote what="Harness 和模型" ask="帮我改一下运行环境：" text="不确定该怎么配？告诉管家你想用哪家模型、哪个 agent，它会出一份变更提案，你确认后生效。" />
      </section>

      {rt.cfg && (
        <>
          <OverrideDrawer rt={rt} h={override.h} open={override.open} onClose={() => setOverride((x) => ({ ...x, open: false }))} />
          <CustomHarnessDrawer rt={rt} editing={custom.editing} open={custom.open} onClose={() => setCustom((x) => ({ ...x, open: false }))} />
        </>
      )}
      <ReasonDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        risk="dangerous"
        title={`删除 harness ${removing?.id ?? ''}`}
        description={removing?.roles.length ? `还有角色在用它：${removing.roles.join('、')}。先把这些角色改到别的 harness，否则保存会被拒绝。` : '删除后路由里不能再选它；agent 本身不会被卸载。'}
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await rt.patch({ harnesses: { [removing!.id]: null } }, reason)
          toast(`已删除 harness ${removing!.id}`)
        }}
      />
    </>
  )
}
