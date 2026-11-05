# 开发简报：M3 Web（外部参考改进，docs/design/19 第 13 节）

**先读**：`AGENTS.md`、`DESIGN.md`（设计系统，必须遵守；token 在 `packages/web/src/styles/tokens.css`）、`docs/design/19-外部参考与改进.md`、`packages/core/src/api.ts` 与 `types.ts` 里本轮新增的类型（见 `docs/dev/m3-backend.md` 开头的清单）。
**数据**：后端在并行开发，本轮一律先走 mock（`?mock=1`），mock 要贴近真实（基于 `examples/standard-delivery` 的场景）。运行时只能 `import type` core。
**气质**：延续"节拍控制室"——克制、精密、有生命力；只有节拍橙一种强调色；不做紫蓝渐变、不做卡通吉祥物。

## 动效规范（本轮起所有新代码必须遵守，旧代码由各自归属人顺手修正）

- 时长：直接反馈 80–120ms；弹层与列表 120–180ms；大弹窗进入 180–220ms、退出 120–180ms；节律类动画以 `--takt`（1200ms）为一拍。
- 位移 2–8px；缩放不低于 0.985；禁止 `scale(0)`、禁止 `transition: all`。
- **进度条 / 用量条用 `transform: scaleX()`，不动画 width / height。**
- 弹层、对话框、⌘K、下拉、抽屉都要有退出动画：用 `lib/motion.tsx` 的 `usePresence`（骨架提供）保留卸载前的最后一帧，快速重开能打断退出。
- 拖拽本体严格跟手，不加缓动；流式文本、虚拟列表行、频繁更新的计数不加入场动画。
- 无限动画（脉动、闪烁、扫光）必须在 `prefers-reduced-motion: reduce` 下静止且仍可见。
- hover 放大只在 `(hover: hover) and (pointer: fine)` 下生效。

## 骨架（S，先做，完成后才开始并行）

1. **数据层**（`api/**`）：DataSource、真实客户端、mock 补齐本轮全部新接口与新字段：
   - 路由预览、命令列表 / 执行、经验列表 / 修改、评审处置；
   - `ReviewSummary.revision / facets`，`NodeDetail` 的 review facets / dispositions、goal / summary / completion / completionChecks / failures；
   - `GraphNode.revision / round / reworks / goal / summary`，`RunDetail.budget / quality`；
   - `RequirementSummary.current / tier / quality`，`ProjectOverview.totals.verified / intercepted`；
   - `AttentionItem.kind / boundTo / stale / assignees`；
   - `Room.lead` 与群聊 SSE 的 `event: lead`（mock 用定时器模拟 thinking → working → waiting → idle），kind `route` 的群消息（带 `route`）；
   - `SpaceMember.duties`、`RepoBinding.bootstrap / share`；
   - workflow 元数据（`EditableWorkflow.meta` 的新键、`setMetaValue`）。
   - mock 场景要覆盖：
     - 一个 T1 需求走 quick-fix；
     - 标准流水线里系分评审打回一次（修订 2）；
     - 一次失败指纹抑制；
     - 一次预算告警；
     - 一个审批已过期（boundTo 的产物有新版本）；
     - 经验库 5 条（试用 / 启用 / 退役各有）。
2. **共享工具**：
   - `lib/motion.tsx`：`usePresence(open, exitMs)` 返回 `{ mounted, state: 'enter' | 'open' | 'exit' }`；
   - `styles/motion.css`：`.shimmer-text`（运行中标题的扫光，节拍色调克制）、`.jump-highlight`（跳转定位后高亮 2.4s 淡出）、`.meter`（scaleX 进度条）；
   - `components/tier-glyph.tsx`：`<TierGlyph tier size? />` 用 SVG 线条表示四档：T0 直线、T1 带一个节点的线、T2 串联三节点、T3 分叉再汇合，颜色继承 currentColor。
3. **占位与挂载**：为下表每个新组件建占位文件（只渲染标题和空状态，props 定好），并挂到页面上：
   - 需求页顶部的预算条与"需要你决策"；
   - 运行页顶部计数与底部事件滚动条；
   - 节点抽屉新 Tab"完成标准"；
   - 设置页新 Tab"经验"；
   - 需求列表"当前节点"列；
   - 总览 KPI。
4. **重写 `packages/web/OWNERSHIP.md`**（M3 版，下表）。

完成定义：`npm run build -w @taktflow/web` 通过。

## 并行小组（文件归属互不重叠；路径相对 `packages/web/src/`）

| 组 | 负责文件 | 本轮内容 |
|---|---|---|
| **A 群聊与路由** | `pages/requirement/chat-tab.tsx`、`pages/requirement/chat/**`、`components/tier-glyph.tsx`、新建 `components/lead-light.*`、新建 `components/route-card.*` | 路由卡消息（档位图标、流程、门禁、角色、理由、调整说明、改档按钮→调命令 `route.preview` 带 tier/reason）；Lead 状态灯（工作：随节拍脉动；等人：琥珀慢闪；空闲：暗呼吸；thinking：扫光；显示在成员栏与群头，悬停显示 detail）；Lead 消息里 `**待确认**` / `**下一步**` 渲染成醒目标签块；从产物 / 节点引用跳转时目标消息 `.jump-highlight`；输入框占位语轮播示例（逐字淡入、快速退出，聚焦或有内容时停止）；支持 URL `?tab=chat&compose=<文本>` 预填（给"告诉 Lead 怎么改"用） |
| **B 评审与待办** | `pages/run/review/**`、`pages/requirement/reviews-tab.*`、`components/attention-card.*`、`pages/attention.tsx`、`pages/run/dag-nodes.tsx`、`pages/run/dag-edges.tsx` | 修订时间线（修订 → 轮次，打回处断开并标原因；全局 seq）；状态三枚标签"结论 · 覆盖 · 新鲜度"（no_findings 显示"无问题"不显示"通过"；stale 用 stale 色）；问题列表加观察标记（新增 / 重复 / 有变化 / 本轮未提及 / 回潮）和人工处置（已解决 / 驳回 / 重新打开，必须填原因，调命令 `review.dispose`）；早停与裁决的展示；DAG 上 review 节点角标显示 `修订·轮次`；待办卡片显示派给谁、绑定的产物版本，过期时提示"审批对象已更新"；待办页加"派给我"筛选 |
| **C 运行页** | `pages/run/**`（除 `review/**`、`dag-nodes.tsx`、`dag-edges.tsx`）、`components/event-timeline.*`、新建 `components/event-ticker.*` | 顶部"已校验 / 已拦截"计数（拦截按来源 tooltip）与 LIVE 标记（运行中时节拍呼吸）；底部实时事件滚动条（最近 N 条，等宽字体，时间戳，悬停暂停，点击定位节点）；节点抽屉头部"目标 / 小结"两行与操作（执行详情 / 告诉 Lead 怎么改 → 跳群聊预填 / 确认通过 → 有待办时）；新 Tab"完成标准"：逐条 pass / 证据、失败指纹列表与被抑制的重试；运行中的节点标题 `.shimmer-text`；事件时间线展示本轮新事件；`drawer.css` 两处 width 动画改 scaleX |
| **D 总览与需求页** | `pages/overview.*`、`components/stat-card.*`、`pages/requirements*.tsx`、`pages/requirement/{index.tsx,requirement.css,artifacts-tab.tsx,metrics-tab.tsx,runs-tab.tsx,activity-tab.tsx,trace-tab.tsx}`、新建 `components/budget-bar.*`、新建 `pages/requirement/decisions.tsx` | 总览 KPI 加"已校验 / 已拦截"；需求列表加档位图标与"当前节点"列（状态点：运行中蓝 / 等人橙，节点名）；需求页顶部信息层级：一句话状态 → 阶段条 → **需要你决策**（待办、预算、重复失败、过期审批，按紧急程度）→ 预算条（scaleX，80% 变色）；产物 Tab 按 spec 类型分组（需求 / 技术 / 测试 / 其他），"只看当前阶段产物"开关；度量 Tab 展示 quality（拦截来源条形图）；`requirement.css` 的 width 动画改 scaleX |
| **E 空间与编辑器** | `pages/settings/**`、`pages/workflow/properties/**`、`pages/workflow/palette/**`、`pages/workflow/canvas/canvas-nodes.tsx` | 设置页新 Tab"经验"（列表：状态、触发条件、帮助 / 坑 / 召回统计；启用 / 退役需原因；正文 Markdown 预览）；成员职责编辑（duties 标签）；仓库的引导命令与共享目录；workflow 编辑器元数据表单（适用场景、档位多选用 TierGlyph、Lead 准则、动态规则、预算）；节点属性：目标、负责人（职责下拉）、完成标准（可增删排序的清单，每条一行）；review 节点：早停轮数、裁决者；画布节点卡片显示目标（一行，超出省略） |
| **F 动效与命令** | `styles/**`、`lib/motion.tsx`、`components/{ui,command-palette,takt,layout,topbar,stage-bar}.*`、新建 `packages/web/scripts/motion-audit.mjs`、`packages/web/package.json` 的 scripts、`.github/workflows/ci.yml`（只加一步）、`DESIGN.md` 的动效章节 | 完善 `usePresence` 并接到 ⌘K、共享弹层 / 下拉 / 对话框原语（`components/ui`）；⌘K 列表来自 `/api/commands`（按 kind 分组，risk 用图标，write / dangerous 需要原因输入，简单输入按 schema 生成表单，需求 / 运行上下文自动带参）；`stage-bar.css`、`ui.css` 的 width 动画改 scaleX；写 `motion-audit.mjs`（扫描 `src/**/*.{css,tsx}`：`transition: all`、`scale(0)`、对 width/height 的 transition、无 reduced-motion 兜底的 infinite 动画、重名 keyframes；输出清单，有违规退出码 1），`npm run motion:audit -w @taktflow/web`，CI 的 build job 加一步；`DESIGN.md` 更新动效规范（上面的数值） |

规则：只改自己名下的文件（可以在名下目录新建）；需要改共享文件（`api/**`、`app.tsx`、`lib/router.tsx`）写进 knownIssues 交给汇总。完成定义：`npx tsc --noEmit -p packages/web` 里自己名下文件无错误；最多 2 张压缩截图自检（`?mock=1`，浅色为主）。

## 汇总

处理各组的共享改动请求与挂载问题；`npm run build -w @taktflow/web`、`npm run motion:audit -w @taktflow/web` 通过；`npx impeccable detect packages/web/src` 无 P0/P1；对每组的主要界面各截 1 张图（浅色 6 张 + 深色 2 张）检查并修正。
