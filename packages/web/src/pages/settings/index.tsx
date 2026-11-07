import { BookOpen, Cpu, GitFork, Lightbulb, SlidersHorizontal, Sparkles, UserRoundCog, Users } from 'lucide-react'
import type { SpaceSettings } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { PageHeader, useCrumbs } from '../../components/layout'
import { ErrorState, Skeleton, SkeletonRows, Tabs } from '../../components/ui'
import { setQuery, useLocation } from '../../lib/router'
import { KnowledgeTab } from './knowledge-tab'
import { LessonsTab } from './lessons-tab'
import { MembersTab } from './members-tab'
import { PolicyTab } from './policy-tab'
import { ReposTab } from './repos-tab'
import { RolesTab } from './roles-tab'
import { RuntimeTab } from './runtime-tab'
import { AskLead } from './settings-kit'
import { SkillsTab } from './skills-tab'
import { UpgradeBanner } from './upgrade-banner'
import './settings.css'
import './space.css'

const TABS = ['policy', 'agents', 'skills', 'knowledge', 'repos', 'lessons', 'members', 'runtime'] as const
type Tab = (typeof TABS)[number]

const ASK_HINT: Record<Tab, string> = {
  policy: '告诉 Lead 你想怎么改，例如：测试前先用 docker compose up 部署，探活 localhost:8080/health',
  agents: '告诉 Lead 你想怎么改，例如：新建一个安全评审角色，只读，挂上接口契约评审技能',
  skills: '告诉 Lead 你想怎么改，例如：把我们的金额格式约定写成一个技能，挂给开发',
  knowledge: '告诉 Lead 你想怎么改，例如：把 docs/wiki 加成知识源',
  repos: '告诉 Lead 你想怎么改，例如：绑定后端仓库 git@example.com:shop/api.git',
  lessons: '告诉 Lead 你想怎么改',
  members: '告诉 Lead 你想怎么改',
  runtime: '告诉 Lead 你想怎么改',
}

/**
 * 空间设置（docs/design/21）：运行策略、角色、技能、知识源、代码仓库、经验；
 * 独立 Web 另有成员和“模型与 Harness”。嵌入 dsh 时用 App 的模型与执行器，这两页不显示。
 * 所有修改都在表单里完成，也可以一句话交给 Lead；每次保存都留修改记录，可恢复。
 */
export function SettingsPage() {
  const ds = useSource()
  const host = ds.host
  const { query } = useLocation()
  const tabs = TABS.filter((t) => (t !== 'members' || host?.manageMembers !== false) && (t !== 'runtime' || host?.manageRuntime !== false))
  const raw = query.get('tab')
  const tab: Tab = tabs.includes(raw as Tab) ? (raw as Tab) : 'policy'
  const sp = useAsync((d) => d.space(), [])
  const st = useAsync((d) => d.settings(), [])
  useCrumbs([{ label: '空间设置' }], [])
  const reload = () => { st.reload(); sp.reload() }
  const replace = (next: SpaceSettings) => st.set(next)

  const error = st.error ?? sp.error
  return (
    <div className="page settings fade-in">
      <PageHeader title={sp.data ? sp.data.name : <Skeleton w={200} h={24} />} sub="空间设置：流程怎么跑、每个角色能做什么、Agent 去哪查资料。" />
      <AskLead page={`settings:${tab}`} placeholder={ASK_HINT[tab]} />
      {st.data?.layout.legacy && <UpgradeBanner issues={st.data.layout.issues} onUpgraded={reload} />}
      {error && !st.data ? (
        <div className="card"><ErrorState error={error} onRetry={reload} /></div>
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(t) => setQuery({ tab: t === 'policy' ? undefined : t, name: undefined })}
            tabs={tabs.map((id) => ({
              policy: { id, label: '运行策略', icon: SlidersHorizontal },
              agents: { id, label: '角色', icon: UserRoundCog, count: st.data?.roles.length },
              skills: { id, label: '技能', icon: Sparkles, count: st.data?.skills.length },
              knowledge: { id, label: '知识源', icon: BookOpen, count: st.data?.config.knowledge.length },
              repos: { id, label: '代码仓库', icon: GitFork, count: sp.data?.repos.length },
              lessons: { id, label: '经验', icon: Lightbulb },
              members: { id, label: '成员', icon: Users, count: sp.data?.members.length },
              runtime: { id, label: '模型与 Harness', icon: Cpu },
            })[id])}
          />
          <div className="space-tab-body">
            {!st.data && ['policy', 'agents', 'skills', 'knowledge'].includes(tab) ? (
              <div className="card"><SkeletonRows rows={8} /></div>
            ) : (
              <>
                {tab === 'policy' && <PolicyTab settings={st.data!} onSaved={replace} />}
                {tab === 'agents' && <RolesTab settings={st.data!} onChanged={reload} />}
                {tab === 'skills' && <SkillsTab settings={st.data!} onChanged={reload} />}
                {tab === 'knowledge' && <KnowledgeTab settings={st.data!} onSaved={replace} />}
              </>
            )}
            {tab === 'repos' && <ReposTab space={sp.data} onChanged={sp.reload} />}
            {tab === 'lessons' && <LessonsTab space={sp.data} />}
            {tab === 'members' && <MembersTab space={sp.data} onSaved={sp.reload} />}
            {tab === 'runtime' && <RuntimeTab />}
          </div>
        </>
      )}
    </div>
  )
}
