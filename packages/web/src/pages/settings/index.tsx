import { BookOpen, Cpu, GitFork, Lightbulb, Sparkles, UserRoundCog, Users, Workflow } from 'lucide-react'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { ErrorState, PageHeader, Skeleton, TabPanel, Tabs, useStewardSuggestions } from '../../components/ui'
import { StewardEditButton } from './ask-steward'
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

const TAB_HINT: Record<Tab, string> = {
  members: '谁在这个空间里、各自负责什么职责；待办按职责派发。',
  repos: '交付会改动的代码仓库，以及每个仓库的安装、构建和测试命令。',
  skills: 'Agent 可以调用的技能说明，改完立即对新运行生效。',
  agents: '每个角色的职责、提示词和默认模型。',
  workflows: '这个空间可用的流水线；新建需求时按需求内容自动选。',
  knowledge: '这个空间绑定的知识库，以及每个知识库给哪些角色用。',
  lessons: '从过往运行里沉淀下来的经验，Agent 在相似场景会参考。',
  runtime: '可用的 Agent CLI 和模型；缺密钥或不可用会标出来。',
}

/**
 * 空间设置（D 组）：成员 / 代码仓库 / 技能 / 角色 / workflow / 知识库 / 经验 / 模型与 harness。
 * 能直接改的都在页面上改（写回空间配置并留审计）；还不能直接改的给"让管家帮我改"，不教人改文件。
 */
export function SettingsPage() {
  const { query } = useLocation()
  const raw = query.get('tab')
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'members'
  const q = useAsync((ds) => ds.space(), [])
  const sp = q.data
  const bindings = useAsync((ds) => ds.knowledgeBindings().catch(() => undefined), [tab === 'knowledge'])
  useCrumbs([{ label: '空间设置' }], [])
  const suggestions = useStewardSuggestions('settings', tab)

  return (
    <div className="page settings">
      <PageHeader
        eyebrow={sp ? sp.name : <Skeleton w={96} h={10} />}
        title="空间设置"
        description={sp ? TAB_HINT[tab] : <Skeleton w={360} h={12} style={{ marginTop: 6 }} />}
        suggestions={suggestions}
        actions={<StewardEditButton ask="帮我改一下空间设置：" size="md" />}
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
              { id: 'knowledge', label: '知识库', icon: BookOpen, count: bindings.data?.length },
              { id: 'lessons', label: '经验', icon: Lightbulb },
              { id: 'runtime', label: '模型与 Harness', icon: Cpu },
            ]}
          />
          <TabPanel key={tab} className="space-tab-body">
            {tab === 'members' && <MembersTab space={sp} onSaved={q.reload} />}
            {tab === 'repos' && <ReposTab space={sp} onChanged={q.reload} />}
            {tab === 'skills' && <FilesTab kind="skill" space={sp} />}
            {tab === 'agents' && <FilesTab kind="agent" space={sp} />}
            {tab === 'workflows' && <WorkflowsTab space={sp} />}
            {tab === 'knowledge' && <KnowledgeTab space={sp} />}
            {tab === 'lessons' && <LessonsTab space={sp} />}
            {tab === 'runtime' && <RuntimeTab />}
          </TabPanel>
        </>
      )}
    </div>
  )
}
