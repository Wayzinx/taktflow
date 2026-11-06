import { BookOpen, Cpu, FileCog, GitFork, Lightbulb, Sparkles, UserRoundCog, Users, Workflow } from 'lucide-react'
import { useAsync } from '../../api'
import { PageHeader, useCrumbs } from '../../components/layout'
import { ErrorState, Skeleton, Tabs } from '../../components/ui'
import { setQuery, useLocation } from '../../lib/router'
import { FilesTab } from './files-tab'
import { KnowledgeTab } from './knowledge-tab'
import { LessonsTab } from './lessons-tab'
import { MembersTab } from './members-tab'
import { ReposTab } from './repos-tab'
import { RuntimeTab } from './runtime-tab'
import { WorkflowsTab } from './workflows-tab'
import './settings.css'
import './space.css'

const TABS = ['members', 'repos', 'skills', 'agents', 'workflows', 'knowledge', 'lessons', 'runtime'] as const
type Tab = (typeof TABS)[number]

/** 空间设置：成员 / 代码仓库 / 技能 / 角色 / workflow / 知识源 / 模型与 harness，对应空间目录里的 takt.config.json 与各子目录。 */
export function SettingsPage() {
  const { query } = useLocation()
  const raw = query.get('tab')
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'members'
  const q = useAsync((ds) => ds.space(), [])
  const sp = q.data
  useCrumbs([{ label: '空间设置' }], [])

  return (
    <div className="page settings fade-in">
      <PageHeader
        title={sp ? <span className="mono">{sp.name}</span> : <Skeleton w={200} h={24} />}
        sub={sp ? sp.description ?? '空间设置' : <Skeleton w={360} h={12} />}
        actions={
          <span className="chip settings-source" title="空间目录里的配置文件；技能和角色在线编辑会写回文件并留痕">
            <FileCog />
            <span className="mono">takt.config.json</span>
          </span>
        }
      />
      {q.error && !sp ? (
        <div className="card">
          <ErrorState error={q.error} onRetry={q.reload} />
        </div>
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(t) => setQuery({ tab: t === 'members' ? undefined : t, name: undefined })}
            tabs={[
              { id: 'members', label: '成员', icon: Users, count: sp?.members.length },
              { id: 'repos', label: '代码仓库', icon: GitFork, count: sp?.repos.length },
              { id: 'skills', label: '技能', icon: Sparkles, count: sp?.skills.length },
              { id: 'agents', label: '角色', icon: UserRoundCog, count: sp?.agents.length },
              { id: 'workflows', label: 'Workflow', icon: Workflow, count: sp?.workflows.length },
              { id: 'knowledge', label: '知识源', icon: BookOpen, count: sp?.knowledge.length },
              { id: 'lessons', label: '经验', icon: Lightbulb },
              { id: 'runtime', label: '模型与 Harness', icon: Cpu },
            ]}
          />
          <div className="space-tab-body">
            {tab === 'members' && <MembersTab space={sp} onSaved={q.reload} />}
            {tab === 'repos' && <ReposTab space={sp} onChanged={q.reload} />}
            {tab === 'skills' && <FilesTab kind="skill" space={sp} />}
            {tab === 'agents' && <FilesTab kind="agent" space={sp} />}
            {tab === 'workflows' && <WorkflowsTab space={sp} />}
            {tab === 'knowledge' && <KnowledgeTab space={sp} />}
            {tab === 'lessons' && <LessonsTab space={sp} />}
            {tab === 'runtime' && <RuntimeTab />}
          </div>
        </>
      )}
    </div>
  )
}
