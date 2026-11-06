# packages/web 文件归属（M3 并行开发，docs/dev/m3-web.md）

每个组只改自己名下的文件（可以在名下目录新建文件）。名下没有、又必须改的文件（尤其是 `api/**`、`app.tsx`、`lib/router.tsx`），写进交付说明的 knownIssues，由汇总合入。路径都相对 `packages/web/src/`。

| 组 | 负责文件 |
|---|---|
| **A 群聊与路由** | `pages/requirement/chat-tab.tsx`、`pages/requirement/chat/**`、`components/tier-glyph.tsx`、`components/lead-light.*`、`components/route-card.*` |
| **B 评审与待办** | `pages/run/review/**`、`pages/requirement/reviews-tab.*`、`components/attention-card.*`、`pages/attention.tsx`、`pages/run/dag-nodes.tsx`、`pages/run/dag-edges.tsx` |
| **C 运行页** | `pages/run/**`（除 `review/**`、`dag-nodes.tsx`、`dag-edges.tsx`）、`components/event-timeline.*`、`components/event-ticker.*` |
| **D 总览与需求页** | `pages/overview.*`、`pages/overview-quality.tsx`、`components/stat-card.*`、`pages/requirements*.tsx`、`pages/requirement/{index.tsx,requirement.css,artifacts-tab.tsx,metrics-tab.tsx,runs-tab.tsx,activity-tab.tsx,trace-tab.tsx,decisions.tsx}`、`components/budget-bar.*` |
| **E 空间与编辑器** | `pages/settings/**`、`pages/workflow/properties/**`、`pages/workflow/palette/**`、`pages/workflow/canvas/canvas-nodes.tsx` |
| **F 动效与命令** | `styles/**`、`lib/motion.tsx`、`components/{ui,command-palette,takt,layout,topbar,stage-bar}.*`、`components/ui/**`（dialog / popover / reason-dialog / overlay.css，经 `components/ui.tsx` 再导出）、`components/command-palette/**`（items / schema / fields / command-form）、新建 `scripts/motion-audit.mjs`、`package.json` 的 scripts、`.github/workflows/ci.yml`（只加一步）、`DESIGN.md` 的动效章节 |
| **m3-web-eval 评测与归因**（docs/dev/m3-eval.md） | 新建 `pages/eval/**`（index / scorecard-table / scorecard-detail / sparkline / runs-list / new-run-dialog / run-detail / case-compare / labels.ts / eval.css / eval-runs.css）、`pages/requirement/defects-tab.*`（tsx / form / attribution / confirm / css）、`pages/run/recipe-section.*`、`api/mock-eval.ts`、`api/mock-eval-scorecards.ts`、`api/mock-eval-runs.ts`、`api/mock-defects.ts`；挂载点：`app.tsx` 的 `/eval` 路由、`components/layout.tsx` 导航"评测"、`pages/requirement/index.tsx` 的"缺陷"Tab、`pages/run/node-drawer.tsx` 的"配方"Tab（`dtab=recipe`）；`api/{source,client,mock,index}.*` 里评测与缺陷相关的方法 |
| **共享（只有汇总能改）** | `api/**`、`app.tsx`、`main.tsx`、`lib/router.tsx`、`lib/{format,status,space,theme,markdown,json-view,capabilities}.*` |

`components/tier-glyph.tsx` 已由骨架完整实现（A 组可微调样式，但 props 不改），D / E 组直接用。`lib/motion.tsx` 与 `styles/motion.css` 由骨架提供，F 组完善；其他组只用、不改。

## 占位组件（骨架已建好并挂到页面；props 不要改，要加 props 写变更请求）

| 组 | 文件 | 导出 | props | 挂载位置 |
|---|---|---|---|---|
| A | `components/route-card.tsx` | `RouteCard` | `{ route: RouteDecision; requirementId: string; runId?: string }` | `chat/message-item.tsx`：`m.kind === 'route' && m.route` 时作为消息体 |
| A | `components/lead-light.tsx` | `LeadLight` | `{ presence?: LeadPresence; showLabel?: boolean }` | `chat/member-list.tsx` 的 Lead 成员行（替代原"工作中"点）；`chat-tab.tsx` 群头（`showLabel`） |
| A | `components/tier-glyph.tsx`（完整实现） | `TierGlyph`、`TIER_LABEL` | `{ tier: Tier; size?: number /*16*/; label?: boolean /*true*/; className?: string }` | 路由卡、需求列表、workflow 元数据表单 |
| C | `pages/run/run-counters.tsx` | `RunCounters` | `{ detail: RunDetail }` | 运行页 `run-title-row`，状态徽标之后 |
| C | `components/event-ticker.tsx` | `EventTicker` | `{ runId: string; live: boolean; liveTick: number; onLocate(nodeId: string): void }` | 运行页底部（`run-body` 之后，`run-page` 的最后一个子元素） |
| C | `pages/run/completion-tab.tsx` | `CompletionTab` | `{ d: NodeView; runId: string; requirementId: string }` | 节点抽屉 `dtab=completion`（"完成标准"；有 completion / completionChecks / failures 时显示） |
| D | `pages/requirement/decisions.tsx` | `Decisions` | `{ requirementId: string; detail?: RequirementDetail; run?: RunDetail; budget?: BudgetStatus }` | 需求页头部，阶段条卡片之后 |
| D | `components/budget-bar.tsx` | `BudgetBar` | `{ budget?: BudgetStatus; runId?: string }` | 需求页头部，`Decisions` 之后 |
| D | `pages/requirements-current.tsx` | `CurrentNodeCell` | `{ current?: RequirementSummary['current']; tier?: Tier }` | `requirements-table.tsx` 的"当前节点"列（`full` 时） |
| D | `pages/overview-quality.tsx` | `QualityStat` | `{ totals: ProjectOverview['totals'] }` | 总览读数条（`StatStrip`）最后一格 |
| E | `pages/settings/lessons-tab.tsx` | `LessonsTab` | `{ space?: SpaceDetail }` | 设置页 `?tab=lessons`（"经验"） |

需求页取最近一次流水线运行：`requirement/index.tsx` 里 `useAsync((ds) => ds.run(r.latestRunId))`，把 `latest.data` 和 `latest.data?.budget` 传给 `Decisions` / `BudgetBar`。

## 共享工具

- `lib/motion.tsx`：`usePresence(open, exitMs = 140)` → `{ mounted, state: 'enter' | 'open' | 'exit' }`；挂载先 `enter` 一帧再 `open`，关闭保留最后一帧 `exitMs`，退出途中重开直接回 `open`，reduced-motion 下不等待。`useLastDefined(value)` 保留最后一个非空值（退出动画期间渲染关闭前的内容）。`prefersReducedMotion()`。CSS 用 `[data-state='enter' | 'exit']` 写初始与退出样式。
- `styles/motion.css`（`main.tsx` 全局引入）：
  - `.shimmer-text`：运行中标题的节拍橙扫光（2 拍一次）；底色用 `--shimmer-base`（默认 `--text`）；
  - `.jump-highlight`：跳转定位后高亮，2.4s 淡出（重新触发时先移除 class 再加，或换 key）；
  - `.meter > .meter-fill`：`--meter` 取 0..1，`transform: scaleX()`；`data-tone="running | success | warning | danger"`，`.meter-lg` 6px 高；
  - reduced-motion：扫光静止为纯色文字，高亮保持 2.4s 后一次性消失，进度条不过渡。

## 数据层（`api/`，共享）

`DataSource`（`source.ts`）本轮新增，HTTP 客户端（`client.ts`，带 `/api/s/:spaceId` 前缀）与演示数据实现同一份：

| 方法 | 路由 |
|---|---|
| `disposeReview(runId, nodeId, ReviewDispositionRequest)` → `ReviewDisposition` | `POST /runs/:runId/nodes/:nodeId/dispositions` |
| `routePreview(requirementId, RoutePreviewRequest)` → `RouteDecision` | `POST /requirements/:id/route` |
| `commands()` → `CommandInfo[]` | `GET /commands` |
| `runCommand(id, CommandRunRequest)` → `CommandRunResponse`（业务失败 `ok: false`，不抛错） | `POST /commands/:id` |
| `lessons(status?)` → `Lesson[]` | `GET /lessons?status=` |
| `updateLesson(id, LessonUpdateRequest)` → `Lesson` | `PATCH /lessons/:id` |
| `subscribeChat(id, onMessage, onLead?)` | 群聊 SSE；`event: lead` 的 data 为 `LeadPresence`，交给 `onLead`。`useChat` 已暴露 `lead`（初值 `Room.lead`） |

`editArtifact` 的 body 支持 `impact: 'cosmetic' | 'semantic'`（cosmetic 不传播 stale）。

演示数据按领域分文件：

| 文件 | 内容 |
|---|---|
| `mock-route.ts` | 各需求的路由卡（REQ-002 带"T3 → T2"调整说明）、`routePreview` 启发式与改档留痕 |
| `mock-quick-fix.ts` | REQ-007（T1，quick-fix）：短 spec → 实现（完成标准 3 条全过）→ 代码评审（运行中）→ 交付校验；worktree 引导、经验召回事件 |
| `mock-m3-nodes.ts` | 节点目标 / 负责人 / 完成标准 / 小结，职责 → 成员（`DUTY_MEMBERS`） |
| `mock-m3-runs.ts` | 预算（REQ-002 告警 84%）、失败指纹抑制（REQ-004 系分门禁同一指纹 2 次 → blocked + `kind: 'retry'` 待办）、过期审批（REQ-003 PRD 审批绑定 spec v1，之后 cosmetic 修改出 v2）、待办 `kind / boundTo / owner / assignees`、`stale` 读模型、`BudgetStatus`、`QualityMetrics` |
| `mock-reviews.ts` | 评审修订与全局 seq（REQ-001 系分评审打回一次 → 修订 2 第 1 轮）、`groupKey / fingerprint`、问题观察（新增 / 重复 / 有变化 / 本轮未提及 / 回潮）、`ReviewFacets`、人工处置 |
| `mock-lessons.ts` | 经验库 5 条：启用 2、试用 2、退役 1 |
| `mock-commands.ts` | 命令注册表与执行校验（write / dangerous 需要 reason） |
| `mock-chat.ts` | 路由卡消息（kind `route`）、Lead 状态灯（订阅后 thinking → working → waiting → idle 循环） |
| `mock-events.ts` | 事件插入与重排哈希链的共用函数 |
| `mock-space.ts` | 成员 `duties`（wayne pm / lin arch,rd / chen rd / qiao qa）、仓库 `bootstrap / share` |
| `mock-workflow-seed.ts` | sdlc 的 `useWhen / tiers / leadInstructions / dynamicRules / budget`；新增 quick-fix workflow |

## 评测与归因（m3-web-eval）

`DataSource` 新增（路由见 `packages/core/src/api.ts`"评测与归因"）：`scorecards(by, workflowId?)`、`evalCases(target?)`、`collectEvalCases`、`evalRuns`、`evalRun`、`startEvalRun`、`evalOutput(runId, caseId, variant)`（后端路由待补，HTTP 404 时返回空 files）、`defects`、`reportDefect`、`attributeDefect`、`confirmDefect`。

| 文件 | 内容 |
|---|---|
| `mock-eval-scorecards.ts` | sdlc 8 个节点成绩单：automate 在 playwright-e2e 更新后疑似退化（87% → 50%），review-design 检出率 60%；按配方 / 技能聚合；`mockRecipe` 给 `NodeDetail.recipe` |
| `mock-eval-runs.ts` | 评测用例（test-design 5 条、playwright-e2e 5 条），ER-0001 better、ER-0002 worse 且挂回归用例 EC-pw-005；新建评测 2.4 秒后出结果；输出快照 |
| `mock-defects.ts` | REQ-001 D-1 已确认（引入 implement/greet-empty，漏检 test-design 与代码评审）、REQ-002 D-1 待确认（引入 design，漏检 review-design / test-design）；新缺陷归因 1.8 秒出候选；确认后生成回归用例 |
| `mock-eval.ts` | 组合以上，接入 `mock.ts`；确认缺陷后成绩单 escapes / detection.missed 实时增加 |

页面：`/eval`（`?by=node|recipe|skill`、`?card=<节点 id | recipeKey | 技能@哈希>` 打开详情；`?tab=runs`、`&run=<id>` 运行详情、`&new=<target>` 新建评测）；需求页 `?tab=defects&defect=D-1`；节点抽屉 `dtab=recipe`。
