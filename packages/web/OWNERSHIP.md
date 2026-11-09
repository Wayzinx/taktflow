# packages/web 文件归属（M4 并行开发，docs/dev/m4-web.md）

每个组只改自己名下的文件（可以在名下目录新建文件）。名下没有、又必须改的共享文件，写进交付说明的 knownIssues，由汇总合入。路径都相对 `packages/web/src/`。只用演示数据（`?mock=1`）。

**体验基线是验收项**（docs/dev/m4-web.md「体验基线」）：页头用 `PageHeader`、四种状态用骨架 / `EmptyState` / `ErrorState` / `toast`、列表首屏 `useStagger`、新行 `useFlashRows`、数字 `CountUp`、Tab 用 `Tabs` + `TabPanel`。`npm run ux:audit -w @taktflow/web` 检查"…""加载中"与 CLI 指引。

| 组 | 负责文件 |
|---|---|
| **A 管家** | `pages/steward/**`、`components/steward/**`（停靠面板、消息、工具卡、引用、提案卡、风险卡、汇报卡、输入框、`context.ts`）、`pages/workflow/edit-fallback.tsx`、`pages/workflow/ask-steward.tsx`、`pages/workflow/canvas/ghost-overlay.tsx`，以及 `pages/workflow/` 下与编辑兜底 / 问管家相关的新文件 |
| **B 增删改** | `components/requirement-create/**`、`components/space-switcher.*`、`components/space-create/**`、`pages/spaces/**`、`pages/requirement/header*`、`pages/requirements*.tsx` 里的主动作（`NewRequirementButton` 的挂载） |
| **C 知识库** | `pages/knowledge/**`、`pages/settings/knowledge-tab.tsx` |
| **D 体验重做** | `pages/{overview*,requirements*,attention}.tsx`（不含 B 的主动作）、`pages/overview.css`、`pages/run/**`、`pages/eval/**`、`pages/settings/**`（不含 knowledge-tab）、`pages/workflows-list*`、`pages/requirement/**`（不含 header*）、`components/{layout,topbar,stage-rail,stat-card,attention-card,event-*,budget-bar,route-card,lead-light,tier-glyph}.*` |
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
| 滚动容器 | 工作区面板 `.shell-main` 自己滚动（docs/design/29）：回顶用 `lib/router` 的 `scrollToTop()`，页面定高用 `--panel-h`，不用 `100vh` / `window.scrollTo` |
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
- **竖向滑块**：列表的选中底色跟着选中项滑过去。`const [ref, glide] = useGlide<HTMLElement>('.item.active')`，容器 `ref={ref}`（要 position: relative / sticky），第一个子元素放 `<GlideMark glide={glide} className="xx-glide" />`，有滑块时把 `.item.active` 自己的底色去掉（例：侧栏 `.sb-glide`、产物列表 `.art-glide`）。
- **分层入场**：`.page` 的直接子块自动分层入场；页面内想让某个容器的子块也依次出现，给容器加 `cascade` 类。
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

## M5 运行透明与归因可信度（docs/dev/m5-web.md）

`DataSource` 另继承 `api/source-m5.ts` 的 `M5Source`，HTTP 客户端在 `api/client-m5.ts`。写冲突（409）统一抛 `RevisionConflictError`，调用方给"别人刚改过 · 载入最新"。

| 组 | 方法 |
|---|---|
| 运行透明 | `timeline`、`nodeChanges`、`nodeDiff`、`rewindPreview`、`rewind`（token 不符 409） |
| 回执 | `resendRoomTask(requirementId, messageId, reason)`、`resendDelegation(messageId, reason)`（只允许 uncertain / expired） |
| 检查点 | `snapshot`、`snapshotFile` |
| 缺陷两层 | `observations`、`updateDefect`（带 `baseRevision`）、`mergeSuggestions`、`decideMerge`、`decideMiss`（带 `reason`、`baseRevision`） |
| 样本与日志 | `createEvalSample`（must_catch 带 `baseRevision`）、`retireEvalSample`、`qualityStatus`、`syncQuality`、`repairQuality` |

新组件：

- **TimeboxBar**（`components/timebox.tsx`）：`<TimeboxBar createdAt timebox assumption form remindedAt handedBack compact />`，待办卡与节点抽屉概览共用。
- **ReceiptRail / HopChain / ResendButton**（`components/receipt.tsx`）：`<ReceiptRail status kind="task|relay" compact />`、`<HopChain hops chain refused />`、`<ResendButton status what onResend roomHref />`；`normReceipt` 把 answered 归到 replied、failed 归到 uncertain。
- **ChangesCard**（`pages/run/changes/changes-card.tsx`）：`limit`（默认 3）、`bare`；内含 `DiffDialog`、`RewindDialog`。
- **CheckpointsTab**（`pages/run/checkpoints-tab.tsx`）：快照、调用身份三层、职责清单；完成的评审者调用可"设为无缺陷样本"。
- **评测报告**（`pages/eval/report.tsx`）：`ReportBadge`、`ReportHead`、`PassRates`、`SampleMatrix`、`IsolationCard`、`RefusedCard`；样本列表 `pages/eval/samples.tsx`（`/eval?tab=cases`）。
- **质量日志**（`pages/settings/quality-tab.tsx`，`/settings?tab=quality`）。

演示数据：

| 文件 | 内容 |
|---|---|
| `mock-m5-run.ts` | 时间泳道与上下文曲线（含 fallback、压缩点、超过 80% 区间）、改动卡与回退（可回退 / 阻止回退各一）、运行中节点的活动行轮换 |
| `mock-m5-checks.ts` | 检查点（3 个评审者，其中一个 skipped；快照只读方式含 none；三层取值含"未知"）、问题台账（claimed_fixed / verified_fixed / not_checked）、门禁 error |
| `mock-defects-m5.ts` / `mock-defects.ts` | REQ-002：9 条观察；D-1 五种漏检结论各一（含 undetermined）、D-2 拦住了但被放行、D-3 与 D-1 的合并建议；D-1 第一次改状态会撞一次写冲突 |
| `mock-eval-samples.ts` | 样本 S-001…S-007（S-007 已退役）；ER-0003 沙箱隔离、门槛达标；ER-0004 拒绝启动；ER-0005 模拟隔离、探索性（含证据不足与误报）；新建评测含旧整节点用例时拒绝启动 |
| `mock-m5-quality.ts` | 质量日志链完整、锚点落后 14 条（可修复）；`?mockQuality=broken` 演示链被篡改（不给修复）；管家转达重发 |
| `mock-data.ts` / `mock-m3-runs.ts` / `mock-chat.ts` / `mock-steward-seed.ts` | 待办时限（接近交还、已交还的假设、只提醒的 approve）；群聊 uncertain 与 refused（跳数超限）任务卡、回执逐站推进与重发；管家 uncertain 转达 |

## 节拍蜂（docs/design/27 §1）

- `components/mascot`：`<Bee state size hue prop tools logo calm still interactive follow onAct />`。`bee-markup.ts`（SVG 内部结构与道具）、`bee-states.ts`（8 个状态的表情 / 间隔 / 动作池、互动反应、工具轮换）、`bee-engine.ts`（挑动作、眨眼、戳、跟随指针）、`bee.css`（部件、姿势、基础循环、`bee-a-*` 动作关键帧、显示规则）。加动作：在状态表里加一条 `{ id, name, w, dur, fx: { 部件: 关键帧 } }`，关键帧写进 `bee.css`。
- 用在：`AgentMark`（运行页节点，在跑 / 等人才挑动作，其余 `calm`）、侧栏品牌标与底部字标、`lib/pulse.ts` favicon、管家头像（历史消息 `still`）与欢迎页、`EmptyState`（大号默认睡着，`mascot={false}` 用图标）、`ErrorState`（大号失败 / 没权限求助）。

## M6：DAG 动效与运行时配置（docs/design/27）

- **DAG 动效**（`pages/run/canvas-motion.ts`）：`useCompletionPulses(nodes)`（节点刚完成 → 出边送信号）、`useReplay(detail)`（已结束运行 6 秒回放）、`decorate(layout, focus, pulses, replay)`（只加类名与 `edge.data`，不重算布局）。边的叠层在 `pages/run/dag-edges.tsx`（`edge-sweep` / `edge-hl` / `edge-comet`），Workflow 编辑器在 `pages/workflow/canvas/canvas-edges.tsx`（`wf-sweep` / `wf-flow`）；共用关键帧在 `styles/motion.css`。
- **模型与 Harness 设置**（`pages/settings/runtime/`，`/settings?tab=runtime`）：`useRuntime()`（运行配置 + 带 baseRevision 的补丁，保存后 `invalidate()`）、`EditorDrawer`（表单 + 必填原因；409 给"重新载入"）、`TestButton`（模型测试先确认"允许一次最小计费请求"）、`ProvidersCard`、`ModelsCard`、`RoutingCard`（角色 / 系统角色）、`OverrideDrawer`（内置 harness 的可执行文件、环境变量、停用）、`CustomHarnessDrawer`（ACP 预设 / 命令，或声明式 CLI）。环境变量值服务端遮盖为 `[REDACTED]`，原样提交表示不改。
- **数据接口**：`api/source-m6.ts`（`M6Source`、`RuntimeConflictError`）、`api/client-m6.ts`。

演示数据：

| 文件 | 内容 |
|---|---|
| `mock-m6-runtime.ts` | 9 个 provider（密钥来源：环境变量 3、本机 2、缺失 2、不需要 1）；10 个模型别名（含一个向量模型）；7 条角色路由（含备选）与 4 个系统角色；自加 harness：OpenCode（ACP 预设）与 Aider（声明式 CLI）；gemini-cli 在本空间停用。测试：Ollama 连不上、缺密钥的 provider 报缺失、ACP 预设里 opencode / claude / codex / goose 能握手；校验与服务端同口径（provider 不存在、harness 停用、自定义 id 与内置冲突、ACP 无预设无命令、向量模型无维度） |
