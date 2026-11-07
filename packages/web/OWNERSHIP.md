# packages/web 文件归属（M4 并行开发，docs/dev/m4-web.md）

每个组只改自己名下的文件（可以在名下目录新建文件）。名下没有、又必须改的共享文件，写进交付说明的 knownIssues，由汇总合入。路径都相对 `packages/web/src/`。只用演示数据（`?mock=1`）。

**体验基线是验收项**（docs/dev/m4-web.md「体验基线」）：页头用 `PageHeader`、四种状态用骨架 / `EmptyState` / `ErrorState` / `toast`、列表首屏 `useStagger`、新行 `useFlashRows`、数字 `CountUp`、Tab 用 `Tabs` + `TabPanel`。`npm run ux:audit -w @taktflow/web` 检查"…""加载中"与 CLI 指引。

| 组 | 负责文件 |
|---|---|
| **A 管家** | `pages/steward/**`、`components/steward/**`（停靠面板、消息、工具卡、引用、提案卡、风险卡、汇报卡、输入框、`context.ts`）、`pages/workflow/edit-fallback.tsx`、`pages/workflow/ask-steward.tsx`、`pages/workflow/canvas/ghost-overlay.tsx`，以及 `pages/workflow/` 下与编辑兜底 / 问管家相关的新文件 |
| **B 增删改** | `components/requirement-create/**`、`components/space-switcher.*`、`components/space-create/**`、`pages/spaces/**`、`pages/requirement/header*`、`pages/requirements*.tsx` 里的主动作（`NewRequirementButton` 的挂载） |
| **C 知识库** | `pages/knowledge/**`、`pages/settings/knowledge-tab.tsx` |
| **D 体验重做** | `pages/{overview*,requirements*,attention}.tsx`（不含 B 的主动作）、`pages/overview.css`、`pages/run/**`、`pages/eval/**`、`pages/settings/**`（不含 knowledge-tab）、`pages/workflows-list*`、`pages/requirement/**`（不含 header*）、`components/{layout,topbar,stage-bar,stat-card,attention-card,event-*,budget-bar,route-card,lead-light,tier-glyph}.*` |
| **共享（只有汇总能改）** | `api/**`、`app.tsx`、`main.tsx`、`lib/**`（含 `ui-store.ts`、`shortcuts.ts`、`router.tsx`、`motion.tsx`）、`components/ui.tsx`、`components/ui/**`、`components/command-palette*`、`styles/**`、`scripts/**`、`package.json` |

`pages/workflow/index.tsx`、`pages/workflow/canvas/workflow-canvas.tsx` 本轮不归任何组：骨架已在里面给 A 预留好挂载点，要改写变更请求。

## 占位组件（骨架已建好并挂载；props 不要改，要加 props 写变更请求）

| 组 | 文件 | 导出 | props | 挂载位置 |
|---|---|---|---|---|
| A | `pages/steward/index.tsx` | `StewardPage` | 无（`?thread=<id>` 选中会话；建议 `?drawer=health\|settings` 开抽屉） | `app.tsx` 路由 `/steward`（全局，带不带 `/s/:space` 都行；`React.lazy` 按需加载） |
| A | `components/steward/dock.tsx` | `StewardDock` | 无（读 `useStewardDock()`：`open / prefill / context / threadId / nonce`） | `app.tsx` 全局一份，第一次打开时才加载（`DockMount`）；底座是 `<Drawer mode="dock">` |
| A | `components/steward/context.ts` | `usePageStewardContext()` | — → `StewardContextRef[]` | 停靠面板自动带上的上下文：路由推导 + `usePageContext()` 声明的 |
| A | `pages/workflow/edit-fallback.tsx` | `EditFallbackBanner` | `{ workflowId: string; wf: WorkflowDocState }`（`wf.readOnly` 为 false 时不渲染） | `pages/workflow/index.tsx` 页头之后，替代原来的只读提示 |
| A | `pages/workflow/ask-steward.tsx` | `AskStewardButton` | `{ workflowId: string; selectedNodeId?: string }` | `pages/workflow/index.tsx` 页头 actions，`SaveStatusBar` 之后 |
| A | `pages/workflow/canvas/ghost-overlay.tsx` | `GhostOverlay` | `{ preview: WorkflowPreview }`（`{ workflowId, proposalId, step }`） | `workflow-canvas.tsx` 的 `<ReactFlow>` 内部（可用 `useReactFlow` / `useViewport`）；画布新 prop `ghost?: WorkflowPreview`，编辑器用 `useWorkflowPreview(id)` 读出 |
| B | `components/requirement-create/index.tsx` | `RequirementCreateDialog` | 无（读 `useCreateRequirement()`：`open / prefill / nonce`） | `app.tsx` 全局一份；占位已能最小可用地创建（标题 + 描述） |
| B | `components/requirement-create/button.tsx` | `NewRequirementButton` | `{ size?: 'sm'; variant?: 'primary' \| 'default'; label?: string; prefill?: { title?, description?, workflowId? } }` | `pages/requirements.tsx` 页头 actions；D 可在总览空状态复用 |
| B | `components/space-create/index.tsx` | `SpaceCreateDialog` | 无（读 `useCreateSpace()`：`open / copyFrom / nonce`） | `app.tsx` 全局一份 |
| B | `pages/spaces/index.tsx` | `SpacesPage` | 无 | `app.tsx` 路由 `/spaces`（全局） |
| B | `pages/requirement/header.tsx` | `RequirementHeader` | `{ id: string; detail?: RequirementDetail; status?: ReactNode; onChanged: () => void }` | `pages/requirement/index.tsx` 的 `<header className="req-header">` 开头；`status` 是 D 的一句话状态（`StatusLine`），渲染在标题下；标题已带 `view-transition-name: vtName('req', id)` |
| C | `pages/knowledge/index.tsx` | `KnowledgeListPage` | 无（建议 `?new=1` 打开新建向导） | `app.tsx` 路由 `/knowledge`（按需加载）；侧栏"知识库" |
| C | `pages/knowledge/detail.tsx` | `KnowledgeDetailPage`、`KNOWLEDGE_TABS` | `{ id: string }`（`?tab=overview\|sources\|builds\|query\|eval\|usage\|settings`） | `app.tsx` 路由 `/knowledge/:id`（按需加载） |

骨架顺手做好的（各组直接用）：侧栏顶部管家 / 搜索 / 收起三个按钮（未读角标来自 `/steward/stream`）、"需求"旁 `+`、⌘J / ⌘B / C 快捷键、⌘K 末项"问管家：…"与"新建需求"、⌘K 页面列表加了管家 / 全部空间 / 知识库、路由转场。

## 全局状态与快捷键（`lib/ui-store.ts`、`lib/shortcuts.ts`，共享）

| 用途 | API |
|---|---|
| 停靠面板 | `openSteward({ prefill?, context?, threadId? })`、`askSteward(text, context?)`、`closeSteward()`、`toggleSteward()`、`useStewardDock()` |
| 页面额外上下文 | `usePageContext(refs, deps)`（卸载时清掉）、`usePageContextExtra()` |
| 未读数 | `setStewardUnread(n)`、`useStewardUnread()`（`components/layout` 已同步 `/steward/feed` 与 `/steward/stream`） |
| 新建需求 | `openCreateRequirement(prefill?)`、`closeCreateRequirement()`、`useCreateRequirement()` |
| 新建空间 | `openCreateSpace({ copyFrom? })`、`closeCreateSpace()`、`useCreateSpace()` |
| 侧栏收起 | `toggleSidebar()`、`useSidebarCollapsed()`（本地记住） |
| workflow 幽灵预览 | `previewWorkflowProposal({ workflowId, proposalId, step } \| undefined)`、`useWorkflowPreview(workflowId)` |
| 快捷键 | `SHORTCUTS`（steward ⌘J / palette ⌘K / sidebar ⌘B / createRequirement C）、`shortcutLabel('mod+j')` → ⌘J、`isMac`；`useGlobalShortcuts()` 已挂在 `app.tsx` |

调试 / 截图开关：
- `?open=steward[&ask=问题&thread=id]`、`?open=create-requirement[&title=&desc=]`、`?open=create-space[&copyFrom=id]`；`?theme=light|dark`。
- 管家：`/steward?thread=<id>`、`?side=feed`（左栏看动态）、`?focus=digest|<风险 key>`（定位到"今天"里的卡）、`?drawer=health|settings`。
- workflow：`/workflows/:id?ghost=1`（画布上预览第一个待决定的提案）；`?mockConvert=fail` 让兜底转换失败（hotfix 默认可转，dryRun:false 后变为可编辑）。
- 知识库：`/knowledge?new=1[&kind=rag]`、`/knowledge/:id?tab=query&q=问题`、`?tab=eval&run=<id>`、`?publish=1`。
- mock：`?mockSingleSpace=1` 模拟单空间模式（新建空间对话框显示原因与 multiSpaceHint）。

汇总后的约定（M4 汇总）：
- 停靠面板打开时，≥1280px 的屏幕把工作区让出 440px（`.shell[data-dock='open']`），workflow 编辑器同时收起节点面板（没选节点时属性面板也让给画布，`.wf-body[data-selected]`）；幽灵预览提示条随画布宽度截断；窄屏仍浮在页面上。
- `WorkflowPreview` 带 `threadId`（画布"去决定"直接打开那个会话）；提案步骤的 `edits` 就是幽灵预览要画的内容，没有本地兜底。
- 管家引用 / 证据跳转的精确落点：需求行、待办卡、运行图节点、知识库卡都带 `data-steward-anchor`（REQ-xxx / requestId / nodeId / kbId）。
- `DigestCard` / `RiskCard`（`components/steward/digest-card`、`risk-card`）可在别的页面复用，`cards.css` 随组件引入。
- `fade-only-in` 是 reduced-motion 的公共兜底关键帧（steward.css、cards.css、edit-fallback.css 在用），改名要同步。
- `EmptyState` 的 `hint` 已全部改为 `body`（`hint` 只作兼容别名保留）；`CountUp` 整数终值的中间帧也取整，并在 duration 后兜底落到终值。

## 原语（`components/ui/`，从 `components/ui` 导入；每个一行用法）

- **PageHeader**：`<PageHeader title="需求" description="7 个需求，4 个进行中" actions={<NewRequirementButton />} suggestions={useStewardSuggestions('requirements')} />`（`titleTransitionName`、`eyebrow`、`icon` 可选；旧 `sub` 仍可用；`SuggestionChips items` 可单独放在卡片里）
- **Skeleton**：`{!q.data ? <SkeletonRows rows={6} /> : <Table />}`；还有 `<Skeleton w h r />`、`<SkeletonText lines={3} />`、`<SkeletonCard />`、`<SkeletonGrid count={6} min={260} />`（120ms 后才淡入）
- **EmptyState**：`<EmptyState icon={BookOpen} title="还没有知识库" body="一句话说明" action={<button className="btn btn-primary">新建</button>} stewardAsk="帮我从 docs/ 建一个文档知识库" />`（`compact` 用于卡片内）
- **ErrorState**：`if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />`（403 自动说明找谁，`contact` 可指定人）
- **toast / Toaster**：`toast('已归档 REQ-007', { undo: () => ds.restoreRequirement('REQ-007', '撤销归档'), tone: 'success' })`；`action: { label, onClick }`、`duration`、`dismissToast(id)`；`<Toaster>` 已挂在 `app.tsx`
- **CountUp**：`<CountUp value={totals.active} from0 />`、`<CountUp value={0.873} format={(v) => \`${(v * 100).toFixed(1)}%\`} />`
- **useStagger**：`const st = useStagger(rows.length)` → `<li key={r.id} {...st(i)}>`，或合并：`className={\`row ${st(i).className ?? ''}\`} style={{ ...mine, ...st(i).style }}`
- **useFlashRows**：`const flash = useFlashRows(rows.map((r) => r.id))` → `<tr className={\`row ${flash(r.id)}\`}>`；单个值用 `useFlashOnChange(value)` 返回 class
- **Segmented**：`<Segmented value={view} onChange={setView} options={[{ value: 'grid', label: '卡片', icon: LayoutGrid, count: 5 }]} size="sm" ariaLabel="视图" />`
- **Chips / Chip**：`<Chips items={ctx.map((c) => ({ id: c.id, label: c.label }))} onRemove={drop} onAdd={pick} />`、`<Chip icon={GitBranch} tone="running" onRemove={…}>shop-web</Chip>`
- **Kbd**：`<Kbd combo="mod+k" />`、`<Kbd>Esc</Kbd>`；tooltip 用 `title={withShortcut('管家', 'mod+j')}`
- **Drawer**：`<Drawer open={open} onClose={close} title="产品健康" description="…" width={520} footer={…}>…</Drawer>`；停靠面板用 `mode="dock"`（无遮罩、不锁焦点）
- **Menu**：`<Menu open={open} onClose={close} anchor={btnRef} items={[{ id: 'archive', label: '归档', icon: Archive, onSelect }, { id: 'del', label: '删除', danger: true, separator: true, onSelect }]} />`（`section`、`hint`、`checked`；↑↓ / Home / End / 首字母 / ↵ / Esc）
- **Tabs / TabPanel**：`<Tabs tabs={…} value={tab} onChange={setTab} />` + `<TabPanel key={tab}>…</TabPanel>`（指示器平移、内容 150ms 淡入）
- **PageTransition / vtName**：`components/layout` 已包好；共享元素：列表里 `<span style={{ viewTransitionName: vtName('req', r.id) }}>`，详情页同名
- **CSS 类**（`styles/motion.css`）：`.live-ring`（运行中呼吸外环，`--live-color` 换色）、`.shimmer-text`（思考中扫光）、`.stream-caret`（流式光标）、`.expand[data-open]`（展开收起）、`.pressable`（非按钮的按压反馈）、`.hover-lift`、`.jump-highlight`、`.meter`

既有原语照旧：`Dialog`、`Popover`、`ReasonDialog`、`Meter`、`StatusBadge`、`StatusDot`、`Avatar`。

## 数据层（`api/`，共享）

`DataSource` 继承 `api/source-m4.ts` 的三组接口；HTTP 客户端在 `api/client-m4.ts`。全局接口（`/steward/*`、`/spaces*`、`/server`）不加 `/s/:spaceId` 前缀，其余空间内接口自动加。`spaces(opts?: { archived?: boolean })`。

| 组 | 方法 |
|---|---|
| 增删改 `CrudSource` | `serverInfo`、`createRequirement`、`updateRequirement`、`archiveRequirement`、`restoreRequirement`、`deleteRequirement`、`createSpace`、`updateSpace`、`archiveSpace`、`restoreSpace`、`deleteSpace(id, { confirm, reason })`、`convertWorkflow(id, { dryRun?, reason? })` |
| 管家 `StewardSource` | `stewardThreads`、`createStewardThread`、`stewardThread` → `{ thread, messages, proposals }`、`postStewardMessage`、`subscribeSteward(threadId, on)`（SSE：message / thinking / tool / delta / proposal / delegation / done / error）、`stewardFeedback`、`proposals`、`approveProposal(id, { hash, reason?, steps? })`、`rejectProposal`、`undoProposal`、`risks({ space?, state? })`、`setRiskState`、`digest`、`stewardFeed`、`subscribeStewardFeed`、`stewardPrefs` / `saveStewardPrefs`、`stewardProfile` / `saveStewardProfile`、`stewardSuggestions({ page, id? })`、`productMetrics`、`reportProductEvent` |
| 知识库 `KnowledgeSource` | `knowledgeKinds`、`knowledgeBases`、`createKnowledgeBase`、`knowledgeBase`、`updateKnowledgeBase`、`deleteKnowledgeBase`、`testKnowledgeBase`、`uploadKnowledge`、`knowledgeDocs`、`startKnowledgeBuild`、`knowledgeBuild`、`subscribeKnowledgeBuild`、`cancelKnowledgeBuild`、`queryKnowledge`、`publishKnowledge`（门槛 409 不抛错，返回 `gate.pass: false`）、`knowledgeEvalSets`、`saveKnowledgeEvalCases`、`synthesizeKnowledgeCases`、`harvestKnowledgeCases`、`knowledgeEvalRuns`、`startKnowledgeEvalRun`、`knowledgeEvalRun`、`knowledgeBindings` / `saveKnowledgeBindings`、`knowledgeSecrets` / `putKnowledgeSecret`、`migrateKnowledge` |

演示数据：

| 文件 | 内容 |
|---|---|
| `mock-crud.ts` | `ServerInfo`（多空间、管家已配置）；空间 hello-delivery、growth-lab、payments「支付中台」、payments-legacy「支付中台（旧版）」（原先同名，已改名）+ 已归档 growth-2025；空间卡片统计（颜色、风险、待办、最近活动）；需求增删改（有运行记录的不能删、运行中不能归档）；workflow 兜底转换（hotfix 可转；`?mockConvert=fail` 转换失败） |
| `mock-steward-seed.ts` / `mock-steward.ts` | 3 个会话（"这周交付进度和风险"含工具卡、引用、待决定的 workflow 提案 pr-review 和已执行的需求提案 pr-req8）；风险 5 条（高 2、中 3；open / snoozed / ignored）；一份汇报；产品健康 8 项；动态与未读 3；偏好、profile、各页建议；发消息后按"思考 → 工具卡逐个出现 → 正文逐字"流式回复，"建需求"类问题会出提案 |
| `mock-knowledge-seed.ts` / `mock-knowledge.ts` | 只在 hello-delivery：商城文档（rag，ready，v3 + 候选 v4）、业务 Wiki（llm-wiki，构建中，进度每 0.8 秒前进）、订单库（database，ready）、开放平台接口（api，草稿）、提交历史（history，ready）；检索测试带 bm25 / vector / rerank 分项，database / api 显示执行语句，写操作被只读守卫拦截；2 个评测集（含候选用例）；kr-12 两变体对比（worse）；发布商城文档 v4 门槛不通过（2 条原因），`force` 带原因可强制发布；其他空间为空 |
