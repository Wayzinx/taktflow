import { CornerDownRight } from 'lucide-react'
import type { StewardContextRef, StewardPick } from '@taktflow/core'
import { useAsync } from '../../api'
import { Bee } from '../../components/mascot'
import { useEntityFocus } from '../../components/steward/focus'
import { LaneTrack } from '../../components/viz'
import { Skeleton, useStagger } from '../../components/ui'
import { StewardHome } from '../steward/home'
import { TonePill } from './entity/shared'

const greeting = () => {
  const h = new Date().getHours()
  return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}

/** 输入框上方：打招呼的节拍蜂 + 一句话。 */
export function SoloHero() {
  const spaces = useAsync((ds) => ds.spaces(), [])
  const n = spaces.data?.length
  return (
    <div className="solo-hello">
      <Bee className="solo-hello-bee" state="greet" size={96} interactive follow label="管家" />
      <h1>{greeting()}，想看哪个需求？</h1>
      <p className="faint">{n ? `我能在你的 ${n} 个空间里找需求、运行和节点，直接画给你看。` : '我能跨空间找需求、运行和节点，直接画给你看。'}</p>
    </div>
  )
}

const QUICK = ['今天有什么进展', '哪些运行失败了', '谁卡住了', '研发用的什么模型']

function PickCard({ p, onOpen, style, className }: { p: StewardPick; onOpen: (p: StewardPick) => void; style?: React.CSSProperties; className?: string }) {
  const s = p.snapshot
  return (
    <button type="button" className={`ent ent-mini pressable${className ? ` ${className}` : ''}`} style={style} onClick={() => onOpen(p)}>
      <span className="ent-head">
        <span className="ent-space">{p.ref.spaceId}</span>
        <span className="ent-id mono">{p.ref.id}</span>
        <span className="ent-gap" />
        <TonePill tone={s.tone} />
      </span>
      <b className="ent-title truncate">{s.title}</b>
      {s.stages && s.stages.length > 0 && <LaneTrack size="sm" cells={s.stages.map((x, i) => ({ key: `${i}`, label: x.label, status: x.status }))} />}
      <span className="ent-note truncate">
        {s.status}
        {p.why && p.reason !== 'waiting' ? ` · ${p.why}` : ''}
      </span>
    </button>
  )
}

/**
 * 输入框下方：短建议、"你可能想看"（服务端按等你 > 失败 > 有风险 > 刚变化 > 在跑挑）、今天的汇报与风险。
 * 点一张需求卡：右侧立刻展开它，同时开会话问它到哪了。
 */
export function SoloHome({ ask }: { ask: (text: string, ctx?: StewardContextRef[]) => void }) {
  const picks = useAsync((ds) => ds.stewardPicks(6), [])
  const focus = useEntityFocus()
  const waiting = (picks.data ?? []).filter((p) => p.reason === 'waiting').length
  const st = useStagger(picks.data?.length ?? 0)
  const open = (p: StewardPick) => {
    focus?.open({ ref: p.ref })
    ask(`${p.ref.id} ${p.snapshot.title} 现在到哪了？`, [p.ref])
  }
  return (
    <div className="solo-home">
      <div className="suggest-row solo-chips" aria-label="可以这样问">
        {waiting > 0 && (
          <button type="button" className="suggest-chip pressable" onClick={() => ask('有哪些等我决定的事？')}>
            等我决定的<b className="num">{waiting}</b>
          </button>
        )}
        {QUICK.map((q) => (
          <button key={q} type="button" className="suggest-chip pressable" onClick={() => ask(q)}>
            {q}
          </button>
        ))}
      </div>

      <section className="solo-sec" aria-label="你可能想看">
        <h2 className="solo-sec-h">
          你可能想看
          <span className="faint">按等你、失败、有风险、刚变化排</span>
        </h2>
        {picks.error && !picks.data ? (
          <p className="faint">{picks.error.message}</p>
        ) : !picks.data ? (
          <div className="solo-picks">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} h={118} r={12} />
            ))}
          </div>
        ) : picks.data.length === 0 ? (
          <p className="solo-empty">
            <CornerDownRight aria-hidden />
            没有等你、失败或刚变化的需求。直接问吧。
          </p>
        ) : (
          <div className="solo-picks">
            {picks.data.map((p, i) => {
              const s = st(i)
              return <PickCard key={`${p.ref.spaceId}/${p.ref.id}`} p={p} onOpen={open} style={s.style} className={s.className} />
            })}
          </div>
        )}
      </section>

      <section className="solo-sec" aria-label="今天">
        <h2 className="solo-sec-h">
          今天
          <span className="faint">汇报与风险</span>
        </h2>
        <StewardHome ask={ask} suggestions={[]} />
      </section>
    </div>
  )
}
