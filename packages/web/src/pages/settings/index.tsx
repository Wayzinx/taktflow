import { useState } from 'react'
import { Boxes, Cpu, FileCog, KeyRound, Route, ServerOff } from 'lucide-react'
import type { HarnessInfo, ModelInfo } from '@taktflow/core'
import { useAsync } from '../../api'
import { PageHeader, useCrumbs } from '../../components/layout'
import { StatCard, StatStrip } from '../../components/stat-card'
import { EmptyState, ErrorState, Segmented, Skeleton, SkeletonRows } from '../../components/ui'
import { CAPABILITIES } from '../../lib/capabilities'
import { HarnessCard } from './harness-card'
import { ModelsTable } from './models-table'
import './settings.css'
import './models.css'

type Filter = 'all' | 'available' | 'unavailable'

function Stats({ harnesses, models }: { harnesses?: HarnessInfo[]; models?: ModelInfo[] }) {
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
  const available = harnesses.filter((h) => h.available)
  const down = harnesses.filter((h) => !h.available)
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
            {available.length}
            <span className="stat-unit">/ {harnesses.length}</span>
          </>
        }
        foot={down.length ? <>不可用：{down.map((h) => h.id).join(' · ')}</> : '全部可用'}
      />
      <StatCard label="模型" icon={<Boxes />} value={models.length} foot={<><b>{providers.size}</b> 个 provider · <b>{protocols.size}</b> 种协议</>} />
      <StatCard
        label="密钥已配置"
        icon={<KeyRound />}
        tone={missingKeys.length ? 'var(--st-waiting)' : undefined}
        value={
          <>
            {models.length - missingKeys.length}
            <span className="stat-unit">/ {models.length}</span>
          </>
        }
        foot={missingKeys.length ? <>缺少：{[...new Set(missingKeys.map((m) => m.provider))].join(' · ')}</> : '只检查环境变量是否存在，不读取值'}
      />
      <StatCard
        label="角色路由"
        icon={<Route />}
        value={bound.reduce((s, h) => s + h.roles.length, 0)}
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

export function SettingsPage() {
  const hq = useAsync((ds) => ds.harnesses(), [])
  const mq = useAsync((ds) => ds.models(), [])
  const [filter, setFilter] = useState<Filter>('all')
  useCrumbs([{ label: '设置' }], [])

  const hs = hq.data
  const shown = hs?.filter((h) => filter === 'all' || (filter === 'available' ? h.available : !h.available)) ?? []
  const downCount = hs?.filter((h) => !h.available).length ?? 0

  return (
    <div className="page settings fade-in">
      <PageHeader
        title="设置"
        sub={
          <>
            已注册的 harness 与模型，与 <span className="mono">takt harness ls</span> / <span className="mono">takt models ls</span> 同一张表；密钥只检查环境变量是否存在，从不显示值。
          </>
        }
        actions={
          <span className="chip settings-source" title="Web 只读；修改 takt.config.json 或插件后刷新">
            <FileCog />
            <span className="mono">takt.config.json</span>
            <span className="faint">只读</span>
          </span>
        }
      />
      <Stats harnesses={hs} models={mq.data} />

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
              { value: 'unavailable', label: downCount ? `不可用 ${downCount}` : '不可用' },
            ]}
          />
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
            <EmptyState compact icon={ServerOff} title={filter === 'unavailable' ? '所有 harness 都可用' : '没有符合条件的 harness'} hint="在 takt.config.json 的 harnesses 里声明 CLI 适配，或通过插件注册。" />
          </div>
        ) : (
          <div className="harness-grid">
            {shown.map((h) => (
              <HarnessCard key={h.id} h={h} />
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="card">
          <div className="card-head">
            <span className="card-title">模型</span>
            {mq.data && <span className="faint num">{mq.data.length}</span>}
            <span className="spacer" />
            <span className="faint models-note">别名在角色和节点的 model 字段里引用；价格用于成本统计</span>
          </div>
          {mq.error && !mq.data ? (
            <ErrorState error={mq.error} onRetry={mq.reload} />
          ) : !mq.data ? (
            <SkeletonRows rows={6} />
          ) : mq.data.length === 0 ? (
            <EmptyState compact icon={Boxes} title="还没有配置模型" hint={<>在 takt.config.json 的 <span className="mono">providers</span> 和 <span className="mono">models</span> 里声明；密钥只写环境变量名（apiKeyEnv）。</>} />
          ) : (
            <ModelsTable models={mq.data} />
          )}
        </div>
      </section>
    </div>
  )
}
