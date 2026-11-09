import { useState, type ReactNode } from 'react'
import { Bell, Check, GitBranch, Inbox, Plus, Search, Settings, Trash2, Workflow } from 'lucide-react'
import type { NodeStatus } from '@taktflow/core'
import { AgentMark, harnessHue, markOf } from '../components/agent-mark'
import { BeeGlyph, LeadMark, StewardMark } from '../components/identity'
import { useCrumbs } from '../components/layout'
import { TaktRuler } from '../components/takt'
import { Avatar, AvatarStack, Chip, EmptyState, ErrorState, Kbd, PageHeader, Segmented, SkeletonRows, StatusBadge, StatusDot, Tabs } from '../components/ui'
import { NODE_STATUS, type Tone } from '../lib/status'
import './ui-gallery.css'

/**
 * 组件陈列（docs/design/30 §1）：全站唯一的写法都在这里。新页面先来这里找；这里没有的，先补进 components/ui 再用。
 * 规则的文字版在 DESIGN.md「组件清单」，违规写法由 ux:audit 拦。
 */

const PEOPLE = ['张晓', '李明远', 'Alex Chen', 'Mia', '王', 'Owen Liu']
const ROLES: Array<[string, string]> = [
  ['pm', '产品'],
  ['architect', '架构'],
  ['dev', '开发'],
  ['test-designer', '测试设计'],
  ['reviewer', '评审'],
  ['judge', '判决'],
  ['planner', '规划'],
  ['lead', 'Lead'],
  ['steward', '管家'],
]
const HARNESSES = ['native', 'claude-code', 'codex', 'gemini', 'cursor', 'qwen']
const STATES: NodeStatus[] = ['pending', 'running', 'waiting_human', 'succeeded', 'failed']
const TONES: Tone[] = ['success', 'running', 'waiting', 'failed', 'stale', 'pending']

function Section({ id, title, rule, children }: { id: string; title: string; rule: ReactNode; children: ReactNode }) {
  return (
    <section className="uig-section" aria-labelledby={`uig-${id}`}>
      <header className="uig-head">
        <h2 id={`uig-${id}`}>{title}</h2>
        <p>{rule}</p>
      </header>
      {children}
    </section>
  )
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="uig-cell">
      <div className="uig-cell-art">{children}</div>
      <figcaption>{label}</figcaption>
    </figure>
  )
}

export function UiGalleryPage() {
  useCrumbs([{ label: '组件陈列' }], [])
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a')
  const [tab, setTab] = useState('one')
  return (
    <div className="page uig">
      <PageHeader title="组件陈列" description="全站的形象、徽标、按钮和空态只有这一套写法；新页面先在这里找，没有的先补进 components/ui。规则见 DESIGN.md「组件清单」。" />

      <Section id="identity" title="身份" rule="人是首字母实色头像；管家、Lead 和每个 Agent 是节拍蜂（角色定道具、harness 定颜色）。不用 ✦、机器人或深色方块表示任何身份。">
        <h3 className="uig-sub">人 · Avatar（16 / 20 / 24 / 32 四档，按 id 稳定取色）</h3>
        <div className="uig-row">
          {[16, 20, 24, 32].map((s) => (
            <Cell key={s} label={`${s}px`}>
              <span className="uig-inline">
                {PEOPLE.map((n) => (
                  <Avatar key={n} name={n} size={s} />
                ))}
              </span>
            </Cell>
          ))}
          <Cell label="AvatarStack">
            <AvatarStack names={PEOPLE} max={4} />
          </Cell>
        </div>

        <h3 className="uig-sub">Agent · AgentMark（小尺寸道具在右下角标，≥ 40px 拿在手里）</h3>
        <div className="uig-row">
          {ROLES.map(([role, label]) => (
            <Cell key={role} label={label}>
              <span className="uig-inline">
                <AgentMark state="idle" role={role} hue={role === 'steward' ? 'var(--honey)' : harnessHue('claude-code')} size={24} />
                <AgentMark state="idle" role={role} hue={role === 'steward' ? 'var(--honey)' : harnessHue('claude-code')} size={48} />
              </span>
            </Cell>
          ))}
        </div>

        <h3 className="uig-sub">harness 着色（同一个 harness 全站同色）</h3>
        <div className="uig-row">
          {HARNESSES.map((h) => (
            <Cell key={h} label={h}>
              <AgentMark state="idle" role="dev" hue={harnessHue(h)} size={32} />
            </Cell>
          ))}
        </div>

        <h3 className="uig-sub">状态（运行图节点、群聊成员）</h3>
        <div className="uig-row">
          {STATES.map((st) => (
            <Cell key={st} label={NODE_STATUS[st].label}>
              <span className="uig-inline">
                <AgentMark {...markOf(st)} role="reviewer" hue={harnessHue('codex')} size={24} />
                <AgentMark {...markOf(st)} role="reviewer" hue={harnessHue('codex')} size={40} />
              </span>
            </Cell>
          ))}
        </div>

        <h3 className="uig-sub">管家与 Lead</h3>
        <div className="uig-row">
          <Cell label="StewardMark 20 / 32">
            <span className="uig-inline">
              <StewardMark size={20} />
              <StewardMark size={32} />
            </span>
          </Cell>
          <Cell label="LeadMark 20 / 32">
            <span className="uig-inline">
              <LeadMark size={20} />
              <LeadMark size={32} harness="codex" />
            </span>
          </Cell>
        </div>
      </Section>

      <Section id="icons" title="图标" rule="按钮、菜单、标签里只用 lucide 线稿（2px 描边）；要一个“管家”图标时用 BeeGlyph，它和 lucide 同规格。彩色的蜂只当头像用，不塞进按钮。">
        <div className="uig-row">
          {[14, 16, 20].map((s) => (
            <Cell key={s} label={`${s}px`}>
              <span className="uig-inline uig-icons" style={{ fontSize: s }}>
                <BeeGlyph size={s} />
                <Search size={s} />
                <Inbox size={s} />
                <Workflow size={s} />
                <Bell size={s} />
                <Settings size={s} />
              </span>
            </Cell>
          ))}
          <Cell label="按钮里">
            <span className="uig-inline">
              <button type="button" className="btn btn-sm">
                <BeeGlyph aria-hidden />
                让管家帮我
              </button>
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="问管家">
                <BeeGlyph />
              </button>
            </span>
          </Cell>
        </div>
      </Section>

      <Section id="status" title="状态" rule="状态只用 StatusBadge / StatusDot，颜色来自状态色板（--st-*），不自己写颜色。">
        <div className="uig-row">
          {(Object.keys(NODE_STATUS) as NodeStatus[]).map((st) => (
            <StatusBadge key={st} meta={NODE_STATUS[st]} />
          ))}
        </div>
        <div className="uig-row">
          {TONES.map((t) => (
            <Cell key={t} label={t}>
              <StatusDot tone={t} pulse={t === 'running'} />
            </Cell>
          ))}
        </div>
      </Section>

      <Section id="buttons" title="按钮与输入" rule="一屏最多一个 .btn-primary；危险操作用 .btn-danger 并要理由；图标按钮必须有 aria-label。">
        <div className="uig-row">
          <button type="button" className="btn btn-primary">
            <Plus aria-hidden />
            新建需求
          </button>
          <button type="button" className="btn">次要动作</button>
          <button type="button" className="btn btn-ghost">幽灵</button>
          <button type="button" className="btn btn-sm">小号</button>
          <button type="button" className="btn btn-danger btn-sm">
            <Trash2 aria-hidden />
            删除
          </button>
          <button type="button" className="btn" disabled>
            不可用
          </button>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="完成">
            <Check />
          </button>
        </div>
        <div className="uig-row">
          <Segmented
            value={seg}
            onChange={setSeg}
            ariaLabel="示例"
            options={[
              { value: 'a', label: '按时间' },
              { value: 'b', label: '按空间' },
              { value: 'c', label: '按需求' },
            ]}
          />
          <Chip icon={GitBranch}>shop-web</Chip>
          <Chip tone="running">运行中</Chip>
          <Chip onRemove={() => undefined}>可移除</Chip>
          <Kbd combo="mod+k" />
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'one', label: '概览' },
            { id: 'two', label: '产物', count: 3 },
            { id: 'three', label: '运行' },
          ]}
        />
      </Section>

      <Section id="empty" title="空态与错误" rule="只用 EmptyState / ErrorState：睡着的蜂 + 一句话 + 一个主动作；卡片里用 compact（48px 蜂）。不在页面里自己拼图标框。">
        <div className="uig-grid">
          <div className="uig-card">
            <EmptyState title="还没有知识库" body="知识库让节点查到业务规则和接口。" action={<button className="btn btn-primary btn-sm">新建知识库</button>} stewardAsk="帮我从 docs/ 建一个文档知识库" />
          </div>
          <div className="uig-card">
            <EmptyState compact title="这个需求还没有运行" body="启动一个 workflow 后，进度会出现在这里。" />
          </div>
          <div className="uig-card">
            <ErrorState compact error={new Error('HTTP 502 Bad Gateway')} onRetry={() => undefined} />
          </div>
        </div>
      </Section>

      <Section id="loading" title="加载" rule="内容加载用骨架屏（Skeleton*），120ms 后才出现；节拍尺（TaktRuler）只表示“正在进行”，不当装饰。">
        <div className="uig-grid">
          <div className="uig-card uig-pad">
            <SkeletonRows rows={3} />
          </div>
          <div className="uig-card uig-pad">
            <TaktRuler ticks={9} running />
          </div>
        </div>
      </Section>
    </div>
  )
}
