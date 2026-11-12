import { BookOpen, Cpu, GitFork, LayoutGrid, Lightbulb, Puzzle, ScrollText, UserRoundCog, Users, Workflow } from 'lucide-react'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { ErrorState, PageHeader, Skeleton, TabPanel, Tabs, useStewardSuggestions } from '../../components/ui'
import { StewardEditButton } from './ask-steward'
import { setQuery, useLocation } from '../../lib/router'
import { FilesTab } from './files-tab'
import { KnowledgeTab } from './knowledge-tab'
import { LessonsTab } from './lessons-tab'
import { MembersTab } from './members-tab'
import { QualityTab } from './quality-tab'
import { ReposTab } from './repos-tab'
import { RuntimeTab } from './runtime-tab'
import { SharedTab } from './shared-tab'
import { WorkflowsTab } from './workflows-tab'
import { SettingsViewer } from './access'
import './settings.css'
import './space.css'

const TABS = ['members', 'repos', 'skills', 'agents', 'shared', 'workflows', 'knowledge', 'lessons', 'runtime', 'quality'] as const
type Tab = (typeof TABS)[number]

const TAB_HINT: Record<Tab, string> = {
  members: '谁在这个空间里、各自负责什么职责；待办按职责派发。',
  repos: '交付会改动的代码仓库，以及每个仓库的安装、构建和测试命令。',
  skills: 'Agent 可以调用的技能说明，改完立即对新运行生效。',
  agents: '每个角色用什么跑、用哪些技能和知识库、能写哪些路径。节点里写了的以节点为准，其次是角色，最后是默认路由。',
  shared: '代码仓库、技能、知识库都挂在空间上，所有角色共用；这里一张表看全每个角色实际用了哪些。',
  workflows: '这个空间可用的流水线；新建需求时按需求内容自动选。',
  knowledge: '这个空间绑定的知识库，以及每个知识库给哪些角色用。',
  lessons: '从过往运行里沉淀下来的经验，Agent 在相似场景会参考。',
  runtime: 'Harness 是执行 Agent 的工具；这里配置模型 API、模型别名和默认路由。',
  quality: '查看日志是否健康、运行记录是否已同步，按需校验或修复。',
}

/**
 * 空间设置（D 组）：成员 / 代码仓库 / 技能 / 角色 / workflow / 知识库 / 经验 / 模型与 harness / 质量日志。
 * 能直接改的都在页面上改（写回空间配置并留审计）；还不能直接改的给"让管家帮我改"，不教人改文件。
 */
export function SettingsPage() {
  const { query } = useLocation()
  const raw = query.get('tab')
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'members'
  const q = useAsync((ds) => ds.space(), [])
  const sp = q.data
  const bindings = useAsync((ds) => ds.knowledgeBindings().catch(() => undefined), [tab === 'knowledge'])
  // 身份加载期间或失败时保持只读，角色门槛以服务端为准
  const me = useAsync((ds) => ds.me(), [])
  // 角色列表含插件 / 内置角色：Tab 徽标、角色 Tab、共享资源 Tab 用同一份；接口不可用（老版本服务端）时退回空间档案
  const roles = useAsync((ds) => ds.agentRoles(), [])
  useCrumbs([{ label: '空间设置' }], [])
  const suggestions = useStewardSuggestions(`settings-${tab === 'runtime' ? 'models' : tab}`)

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
        <SettingsViewer.Provider value={me.data}>
          <Tabs
            value={tab}
            onChange={(t) => setQuery({ tab: t === 'members' ? undefined : t, name: undefined })}
            tabs={[
              { id: 'members', label: '成员', icon: Users, count: sp?.members.length },
              { id: 'repos', label: '代码仓库', icon: GitFork, count: sp?.repos.length },
              { id: 'skills', label: '技能', icon: Puzzle, count: sp?.skills.length },
              { id: 'agents', label: '角色', icon: UserRoundCog, count: roles.data?.length ?? (roles.error ? sp?.agents.length : undefined) },
              { id: 'shared', label: '共享资源', icon: LayoutGrid },
              { id: 'workflows', label: '流水线', icon: Workflow, count: sp?.workflows.length },
              { id: 'knowledge', label: '知识库', icon: BookOpen, count: bindings.data?.length },
              { id: 'lessons', label: '经验', icon: Lightbulb },
              { id: 'runtime', label: '模型与 Harness', icon: Cpu },
              { id: 'quality', label: '质量日志', icon: ScrollText },
            ]}
          />
          <TabPanel key={tab} className="space-tab-body">
            {tab === 'members' && <MembersTab space={sp} onSaved={q.reload} />}
            {tab === 'repos' && <ReposTab space={sp} onChanged={q.reload} />}
            {tab === 'skills' && <FilesTab kind="skill" space={sp} onChanged={q.reload} />}
            {tab === 'agents' && <FilesTab kind="agent" space={sp} roles={roles} onChanged={q.reload} />}
            {tab === 'shared' && <SharedTab space={sp} roles={roles} />}
            {tab === 'workflows' && <WorkflowsTab space={sp} />}
            {tab === 'knowledge' && <KnowledgeTab space={sp} />}
            {tab === 'lessons' && <LessonsTab space={sp} />}
            {tab === 'runtime' && <RuntimeTab />}
            {tab === 'quality' && <QualityTab />}
          </TabPanel>
        </SettingsViewer.Provider>
      )}
    </div>
  )
}
