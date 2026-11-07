import { useState } from 'react'
import { Boxes, Cpu, KeyRound, Route, ServerOff } from 'lucide-react'
import type { HarnessInfo, ModelInfo } from '@taktflow/core'
import { useAsync } from '../../api'
import { StatCard, StatStrip } from '../../components/stat-card'
import { CountUp, EmptyState, ErrorState, Segmented, Skeleton, SkeletonRows, useStagger } from '../../components/ui'
import { StewardEditButton, StewardEditNote } from './ask-steward'
import { CAPABILITIES } from '../../lib/capabilities'
import { HarnessCard } from './harness-card'
import { ModelsTable } from './models-table'
import './models.css'

/** 整数读数：过渡中途也按整数显示（CountUp 默认格式会在中途露出小数）。 */

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
            <CountUp value={available.length} />
            <span className="stat-unit">/ {harnesses.length}</span>
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
        foot={missingKeys.length ? <>缺少：{[...new Set(missingKeys.map((m) => m.provider))].join(' · ')}</> : '只检查环境变量是否存在，不读取值'}
      />
      <StatCard
        label="角色路由"
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

export function RuntimeTab() {
  const hq = useAsync((ds) => ds.harnesses(), [])
  const mq = useAsync((ds) => ds.models(), [])
  const [filter, setFilter] = useState<Filter>('all')

  const hs = hq.data
  const shown = hs?.filter((h) => filter === 'all' || (filter === 'available' ? h.available : !h.available)) ?? []
  const downCount = hs?.filter((h) => !h.available).length ?? 0
  const st = useStagger(shown.length)

  return (
    <>
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
              { value: 'unavailable', label: '不可用', count: downCount || undefined },
            ]}
            size="sm"
            ariaLabel="按可用性筛选"
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
            <EmptyState
              compact
              icon={ServerOff}
              title={filter === 'unavailable' ? '所有 harness 都可用' : '没有符合条件的 harness'}
              body={filter === 'unavailable' ? '每个 harness 都能正常调起。' : '接入一个新的 Agent CLI（Claude Code、Codex 等）后会出现在这里。'}
              action={filter !== 'all' ? <button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button> : undefined}
              stewardAsk={filter === 'all' ? '帮我接入一个新的 harness：' : undefined}
            />
          </div>
        ) : (
          <div className="harness-grid">
            {shown.map((h, i) => (
              <div key={h.id} {...st(i)}>
                <HarnessCard h={h} />
              </div>
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
            <span className="faint models-note">别名在角色和节点里引用；价格用于成本统计</span>
            <StewardEditButton ask="帮我调整模型配置：" ghost />
          </div>
          {mq.error && !mq.data ? (
            <ErrorState error={mq.error} onRetry={mq.reload} />
          ) : !mq.data ? (
            <SkeletonRows rows={6} />
          ) : mq.data.length === 0 ? (
            <EmptyState compact icon={Boxes} title="还没有配置模型" body="加一个模型后，角色和节点就能按别名引用它；密钥只记环境变量名，不保存明文。" stewardAsk="帮我加一个模型：provider 是 " />
          ) : (
            <ModelsTable models={mq.data} />
          )}
        </div>
        <StewardEditNote what="Harness 和模型" ask="帮我改一下运行环境：" />
      </section>
    </>
  )
}
