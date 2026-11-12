import { useRef, useState } from 'react'
import { Boxes, Cpu, Eye, EyeOff, KeyRound, MoreHorizontal, Pencil, Plus, Route, ServerOff, Settings2, Trash2 } from 'lucide-react'
import type { HarnessInfo, ModelInfo, RuntimeConfig, RuntimeTestResult } from '@taktflow/core'
import { useAsync } from '../../api'
import { StatCard, StatStrip } from '../../components/stat-card'
import { CountUp, EmptyState, ErrorState, Menu, ReasonDialog, Segmented, Skeleton, toast, useFlashRows, useStagger } from '../../components/ui'
import { StewardEditNote } from './ask-steward'
import { DownGroup, HarnessListHead, HarnessRow } from './harness-list'
import { harnessMeta, isTestOnly } from '../../lib/harness-meta'
import { CustomHarnessDrawer, OverrideDrawer } from './runtime/harness-edit'
import { ModelsCard } from './runtime/models'
import { PairingMatrix } from './runtime/pairing-matrix'
import { ProvidersCard } from './runtime/providers'
import { RoutingCard } from './runtime/routing'
import { TestButton, TestOutcome, useRuntime, type RuntimeApi } from './runtime/shared'
import { ReadOnlyNote, useAccess } from './access'
import './models.css'
import './runtime/runtime.css'

/** 整数读数：过渡中途也按整数显示（CountUp 默认格式会在中途露出小数）。 */

type Filter = 'all' | 'available' | 'unavailable'

/** 只在还在读时给骨架；某一路读失败，依赖它的卡写明没读到，其余照常出数。 */
function Stats({ harnesses, models, cfg, failed }: { harnesses?: HarnessInfo[]; models?: ModelInfo[]; cfg?: RuntimeConfig; failed: { harnesses: boolean; models: boolean } }) {
  if ((!harnesses && !failed.harnesses) || (!models && !failed.models)) {
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
  const unread = (ok: unknown, what: string) => (ok ? {} : { tone: 'var(--st-failed)', value: '—', foot: `${what}没读到，原因见下方` })
  const live = (harnesses ?? []).filter((h) => !h.override?.disabled)
  const available = live.filter((h) => h.available)
  const down = live.filter((h) => !h.available)
  const local = cfg ? Object.values(cfg.keys).filter((k) => k === 'local').length : 0
  const missingKeys = (models ?? []).filter((m) => !m.keyPresent)
  const providers = new Set(models?.map((m) => m.provider))
  const protocols = new Set(models?.map((m) => m.protocol))
  const bound = (harnesses ?? []).filter((h) => h.roles.length > 0)
  // 默认路由只算设置里配的（cfg.roles），和下面路由卡同一个数；角色档案自己选的 Harness 不算
  const routes = Object.values(cfg?.roles ?? {})
  const byHarness = [...routes.reduce((m, s) => m.set(s.harness, (m.get(s.harness) ?? 0) + 1), new Map<string, number>())]
  return (
    <StatStrip label="运行环境读数">
      <StatCard
        label="Harness 可用"
        icon={<Cpu />}
        tone={down.some((h) => h.roles.length > 0) ? 'var(--st-failed)' : undefined}
        value={
          <>
            <CountUp value={available.length} />
            <span className="stat-unit">/ {live.length}</span>
          </>
        }
        foot={
          down.some((h) => h.roles.length > 0) ? (
            <>有角色在用但不可用：{down.filter((h) => h.roles.length > 0).map((h) => h.id).join(' · ')}</>
          ) : down.length ? (
            <>{down.length} 个没装或没登录，没有角色在用</>
          ) : (
            '全部可用'
          )
        }
        {...unread(harnesses, 'Harness 清单')}
      />
      <StatCard label="模型" icon={<Boxes />} value={<CountUp value={models?.length ?? 0} />} foot={<><b>{providers.size}</b> 个 provider · <b>{protocols.size}</b> 种协议</>} {...unread(models, '模型清单')} />
      <StatCard
        label="密钥已配置"
        icon={<KeyRound />}
        tone={missingKeys.length ? 'var(--st-waiting)' : undefined}
        value={
          <>
            <CountUp value={(models?.length ?? 0) - missingKeys.length} />
            <span className="stat-unit">/ {models?.length ?? 0}</span>
          </>
        }
        foot={missingKeys.length ? <>缺少：{[...new Set(missingKeys.map((m) => m.provider))].join(' · ')}</> : local ? <><b>{local}</b> 个存在本机密钥库 · 其余来自环境变量</> : '只检查密钥在不在，不读取值'}
        {...unread(models, '模型清单')}
      />
      <StatCard
        label="默认路由"
        icon={<Route />}
        value={<CountUp value={routes.length} />}
        foot={
          routes.length
            ? byHarness.map(([h, n]) => `${h} ${n}`).join(' · ')
            : bound.length
              ? `${bound.reduce((s, h) => s + h.roles.length, 0)} 个角色按档案或内置默认选 Harness`
              : '还没有默认路由'
        }
      />
    </StatStrip>
  )
}

function HarnessSkeleton() {
  return (
    <ul className="card hx-list">
      {[0, 1, 2].map((i) => (
        <li key={i} className="hx-row">
          <div className="hx-main hx-skel">
            <Skeleton w={30} h={30} r={8} />
            <Skeleton w="40%" h={12} />
            <Skeleton w="70%" h={10} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** 行上的操作：测试（探测 / ACP 握手）+ 菜单（内置：设置、隐藏；自加的：编辑、删除）。不可用的内置 Harness 直接给「隐藏」，已隐藏的给「取消隐藏」。 */
function HarnessActions({ h, rt, onResult, onSettings, onEdit, onRemove }: { h: HarnessInfo; rt: RuntimeApi; onResult: (r: RuntimeTestResult | undefined) => void; onSettings: () => void; onEdit: () => void; onRemove: () => void }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [toggling, setToggling] = useState(false)
  const disabled = Boolean(h.override?.disabled)
  const builtin = !h.custom && h.source !== 'plugin'
  return (
    <>
      {!disabled && <TestButton target={{ kind: 'harness', id: h.id }} onResult={onResult} ghost />}
      {rt.cfg && builtin && (disabled || !h.available) && (
        <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={disabled ? `取消隐藏 ${h.displayName}` : `隐藏 ${h.displayName}`} title={disabled ? '取消隐藏' : '隐藏：内置的不能删除，隐藏后不进路由和选择器'} onClick={() => setToggling(true)}>
          {disabled ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
        </button>
      )}
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
                    { id: 'toggle', label: disabled ? '在本空间取消隐藏' : '在本空间隐藏', icon: disabled ? Eye : EyeOff, separator: true, danger: !disabled, onSelect: () => setToggling(true) },
                  ]
            }
          />
          <ReasonDialog
            open={toggling}
            onClose={() => setToggling(false)}
            risk={disabled ? 'write' : 'dangerous'}
            title={disabled ? `取消隐藏 ${h.displayName}` : `在本空间隐藏 ${h.displayName}`}
            description={
              disabled
                ? '取消隐藏后路由和探测都能看到它。'
                : h.roles.length
                  ? `还有角色在用它：${h.roles.join('、')}。先把这些角色改到别的 Harness，否则保存会被拒绝。`
                  : '隐藏后路由、选择器和探测都看不到它，内置的 Harness 不能删除，隐藏就是移出列表；正在跑的节点不受影响。'
            }
            confirmLabel={disabled ? '取消隐藏' : '隐藏'}
            onSubmit={async (reason) => {
              const o = { ...rt.cfg!.harnessOverrides[h.id] }
              if (disabled) delete o.disabled
              else o.disabled = true
              await rt.patch({ harnessOverrides: { [h.id]: Object.keys(o).length ? o : null } }, reason)
              toast(disabled ? `${h.displayName} 已取消隐藏` : `${h.displayName} 已在本空间隐藏`)
            }}
          />
        </>
      )}
    </>
  )
}

export function RuntimeTab() {
  const access = useAccess('owner', '改模型、Harness 和路由，以及测试连通性')
  const hq = useAsync((ds) => ds.harnesses(), [])
  const mq = useAsync((ds) => ds.models(), [])
  const rt = useRuntime()
  const [filter, setFilter] = useState<Filter>('all')
  const [results, setResults] = useState<Record<string, RuntimeTestResult | undefined>>({})
  const [override, setOverride] = useState<{ open: boolean; h?: HarnessInfo }>({ open: false })
  const [custom, setCustom] = useState<{ open: boolean; editing?: string }>({ open: false })
  const [removing, setRemoving] = useState<HarnessInfo>()
  const [downOpen, setDownOpen] = useState(false)

  // 测试替身不进列表；真有角色指到它时才露出来，免得配置看不见
  const hs = hq.data?.filter((h) => !isTestOnly(h) || h.roles.length > 0)
  const shown = hs?.filter((h) => filter === 'all' || (filter === 'available' ? h.available : !h.available)) ?? []
  const downCount = hs?.filter((h) => !h.available && !h.override?.disabled).length ?? 0
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const st = useStagger(shown.length)
  const flash = useFlashRows(shown.map((h) => h.id))
  // 「全部」里不可用的折成一组；只看不可用时直接平铺
  const up = filter === 'unavailable' ? [] : shown.filter((h) => h.available && !h.override?.disabled)
  const down = shown.filter((h) => !h.available && !h.override?.disabled)
  const hidden = shown.filter((h) => h.override?.disabled)
  const row = (h: HarnessInfo, i: number) => {
    const sx = st(i)
    return (
      <HarnessRow
        key={h.id}
        h={h}
        below={results[h.id] && <div className={['hx-below', sx.className, flash(h.id)].filter(Boolean).join(' ')}><TestOutcome r={results[h.id]!} /></div>}
        actions={
          access.ok && (
            <HarnessActions
              h={h}
              rt={rt}
              onResult={(r) => setResults((m) => ({ ...m, [h.id]: r }))}
              onSettings={() => setOverride({ open: true, h })}
              onEdit={() => setCustom({ open: true, editing: h.id })}
              onRemove={() => setRemoving(h)}
            />
          )
        }
      />
    )
  }

  return (
    <>
      <ReadOnlyNote why={access.why} block />
      <Stats harnesses={hs} models={mq.data} cfg={rt.cfg} failed={{ harnesses: !!hq.error, models: !!mq.error }} />
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
          {rt.cfg && access.ok && (
            <button type="button" className="btn btn-sm" onClick={() => setCustom({ open: true })}>
              <Plus aria-hidden /> 添加 Harness
            </button>
          )}
        </div>
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
              title={filter === 'unavailable' ? '所有 Harness 都可用' : '没有符合条件的 Harness'}
              body={filter === 'unavailable' ? '每个 Harness 都能正常调起。' : '接入一个支持 ACP 的 agent，或一个声明式 CLI。'}
              action={filter !== 'all' ? <button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button> : rt.cfg && access.ok ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setCustom({ open: true })}>添加 Harness</button> : undefined}
            />
          </div>
        ) : (
          <ul className="card hx-list">
            <HarnessListHead />
            {up.map(row)}
            {filter === 'unavailable'
              ? down.map((h, i) => row(h, i))
              : down.length > 0 && (
                  <DownGroup count={down.length} names={down.map((h) => harnessMeta(h).name)} open={downOpen} onToggle={() => setDownOpen((x) => !x)}>
                    {down.map((h, i) => row(h, up.length + i))}
                  </DownGroup>
                )}
            {hidden.length > 0 && (
              <DownGroup label={`已隐藏 ${hidden.length} 个`} hint="不进路由和选择器，可以取消隐藏" count={hidden.length} names={hidden.map((h) => harnessMeta(h).name)} open={hiddenOpen} onToggle={() => setHiddenOpen((x) => !x)}>
                {hidden.map((h, i) => row(h, up.length + down.length + i))}
              </DownGroup>
            )}
          </ul>
        )}
      </section>

      {rt.cfg && (
        <section className="settings-section">
          <PairingMatrix rt={rt} harnesses={hs} models={mq.data} />
        </section>
      )}

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
        title={`删除 Harness ${removing?.id ?? ''}`}
        description={removing?.roles.length ? `还有角色在用它：${removing.roles.join('、')}。先把这些角色改到别的 Harness，否则保存会被拒绝。` : '删除后路由里不能再选它；agent 本身不会被卸载。'}
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await rt.patch({ harnesses: { [removing!.id]: null } }, reason)
          toast(`已删除 Harness ${removing!.id}`)
        }}
      />
    </>
  )
}
