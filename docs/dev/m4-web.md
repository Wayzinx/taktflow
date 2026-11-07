# 开发简报：M4 Web（管家、增删改、知识库、体验重做；docs/design/22、23）

**先读**：
- `docs/design/22-管家与操作体验.md`，尤其是第 3 节"体验与动效"；
- `docs/design/23-知识库体系.md` 的"页面"一节；
- `DESIGN.md`；
- `docs/dev/m3-web.md` 的动效规范（仍然有效）；
- `packages/core/src/api.ts` 里本轮新增的三节：增删改、管家、知识库。

用户对现状的原话是"太粗糙"：
- 页面体验一般；
- 很多事做不了；
- 没有 Agent 帮忙；
- 没有动效和衔接。

本轮的目标是让人**愿意每天用**。下面每一条都是验收项。

## 体验基线（所有页面都要满足，汇总 agent 逐页检查）

1. **页头**：统一用 `<PageHeader title description actions suggestions />`。
   - 主动作放在右侧；
   - 管家建议以最多 3 个小胶囊的形式显示在 description 下方，点击后打开停靠面板并预填问题。
2. **四种状态**：
   - **加载**：用 `<Skeleton>`，形状要贴近真实布局；加载超过 120ms 才显示。禁止用"…"或"加载中"文字代替。
   - **空**：用 `<EmptyState icon title body action stewardAsk />`，写一句话和一个主动作；不许教用户去改文件或跑 CLI。
   - **错误**：用 `<ErrorState error onRetry />`。
   - **成功**：用 `toast()`，能撤销的带撤销。
3. **转场**：
   - 路由切换：淡出 120ms；淡入加上移 6px，200ms。浏览器支持时用 `document.startViewTransition`。需求标题从列表到详情做共享元素过渡，用 `view-transition-name`。
   - Tab：下划线指示器平移，内容交叉淡化 150ms。
4. **列表**：
   - 首屏逐项入场：每项间隔 24ms，最多 10 项，单项 160ms；
   - 之后的数据更新不再做入场动画；
   - 新行底色闪一下，1.2s 淡出。
5. **数字**：总览统计和卡片数字用 `<CountUp>`（400ms，等宽数字）。
6. **按压与焦点**：
   - 按钮按下时 `scale(.98)`，80ms；
   - 焦点环淡入；
   - 所有可点元素都要有 hover 和 active 反馈。
7. **实时状态**：
   - 运行中：按 `--takt` 节拍呼吸的外环；
   - 思考中：`.shimmer-text` 扫光；
   - 流式文本：末尾光标闪烁；
   - 展开：用 `grid-template-rows: 0fr → 1fr`。
8. **视觉**：
   - 三层表面：页面底、卡片、浮层。浅色主题用细阴影，深色主题用亮度加描边来区分层次。少套框，多用间距分组。
   - 强调色（takt-orange）只用在主动作和实时状态。
   - 刻度：圆角 6 / 10 / 14；字号 12 / 13 / 14 / 16 / 20 / 28；间距 8px 网格。
9. **reduced-motion**：去掉位移和缩放，只保留透明度变化；无限动画静止但仍然可见。
10. **快捷键**：

    | 快捷键 | 作用 |
    |---|---|
    | ⌘J | 管家面板 |
    | ⌘K | 命令面板 |
    | C | 新建需求，不在输入框里时生效 |
    | ⌘B | 收起侧栏 |

    快捷键在对应按钮的 tooltip 里显示。

## 骨架（S，先做；完成后才开始并行）

1. **设计系统更新**：
   - 更新 `styles/tokens.css`，补齐上面的刻度，加上 `--elev-1/2/3` 阴影 token 和 `--ease-out-soft: cubic-bezier(.2,.8,.2,1)`；
   - `DESIGN.md` 同步更新。
2. **新原语**，放在 `components/ui/`：
   - 页面结构：`page-header`、`page-transition`（路由转场，接进 `components/layout`）；
   - 状态：`skeleton`、`empty-state`、`error-state`；
   - 反馈：`toast`（`toast(msg, { undo?, tone? })` 加 `<Toaster>`）；
   - 动效：`count-up`、`stagger`（`useStagger(n)` 返回每项的 style）、`flash-row`；
   - 表单：`segmented`、`chips`（可移除的标签）、`kbd`；
   - 抽屉：`drawer`，右侧停靠面板的底座，带退出动画；
   - 菜单：`menu`，下拉菜单，走浮层原语，含键盘导航。

   动效都放在 `styles/motion.css`，带 reduced-motion 兜底。
3. **数据层**：
   - `api/source.ts` 的 DataSource 和 `api/client.ts` 补齐 api.ts 三节新增的全部接口，包括：
     - SSE：管家线程流、全局 feed、知识库构建；
     - `/api/s/:spaceId` 前缀；
     - 全局接口（`/api/steward/*`、`/api/spaces`、`/api/server`）不加前缀。
   - mock 按领域拆成三个文件：`mock-steward.ts`、`mock-knowledge.ts`、`mock-crud.ts`。
4. **路由与导航**：
   - **新路由**：
     - `/steward`：全局，不带空间前缀也能访问；
     - `/spaces`：全局；
     - `/s/:space/knowledge` 和 `/s/:space/knowledge/:id`：删掉原来重定向到 `settings?tab=knowledge` 的逻辑。
   - **侧栏顶部**：空间切换器右侧放三个图标按钮：管家（⌘J，有未读时显示角标）、搜索（⌘K）、收起侧栏（⌘B）。
   - **侧栏导航**："需求"右侧加 `+`（新建需求）；"知识库"指向新页面。
   - **全局挂载**：在 `app.tsx` 挂上停靠面板（占位）、Toaster、新建需求对话框（占位，由 store 控制开关）。
5. **占位组件**：为各组的新组件建占位文件，定好 props 并挂到页面上。
6. **OWNERSHIP.md**：重写成 M4 版。内容包括下表、每个占位组件的文件 / 导出名 / props / 挂载位置，以及新原语的用法示例（每个一行）。
7. **`scripts/ux-audit.mjs`**：扫描 `src/pages/**`、`src/components/**`。
   - 报违规：JSX 文本里用"…"或"加载中"表示加载状态。
   - 报警告：出现 `takt.config.json`，或"运行 takt"这类 CLI 指引。
   - 配置 `npm run ux:audit -w @taktflow/web`；CI 的 build job 里加一步。

**mock 场景**（让每个页面都有内容可看）：
- 4 个空间，其中两个原先同名，已改成不同的名字；外加 1 个已归档空间。
- 管家：
  - 3 个会话，其中一个包含工具调用卡、引用、一个待决定的 workflow 提案和一个已执行的需求提案；
  - 风险 5 条，覆盖三种级别和状态；
  - 一份汇报；
  - 产品健康指标 8 项；
  - 线程流 mock 要能逐字流式输出。
- 知识库：
  - 5 个：rag ready、llm-wiki 构建中、database ready、api 草稿、history ready；
  - 一次进行中的构建，进度会动；
  - 检索测试有分项得分；
  - 2 个评测集，1 次带比较的评测运行，一次门槛不通过的发布。

## 并行小组

| 组 | 负责文件 | 本轮内容 |
|---|---|---|
| **A 管家** | `pages/steward/**`、`components/steward/**`（停靠面板、消息、工具卡、引用、提案卡、风险卡、汇报卡、输入框）、`pages/workflow/**` 中与编辑兜底和问管家相关的新文件，以及骨架在 `pages/workflow/index.tsx` 里预留的挂载点 | 整页 `/steward`：左侧是会话列表和"动态"，右侧是对话；顶部有"产品健康"入口，以抽屉形式展开。停靠面板：自动带上当前页上下文标签。输入框：`@` 引用、`/` 命令、附件、Enter 发送、Shift+Enter 换行。流式输出：思考扫光 → 工具卡逐个出现 → 正文逐字显示。引用 `[n]` 悬停预览，点击跳转并高亮。提案卡：标题、风险、每步预览（diff 或参数表单，可以直接改）、批准 / 拒绝（拒绝时可填原因）/ 撤销倒计时；执行成功时对勾描边动画。workflow 提案在画布上做幽灵预览：在 `pages/workflow/canvas` 里**新建** `ghost-overlay.tsx`，由骨架预留 prop。workflow 编辑兜底：解析失败时显示横幅 →"转换为可编辑格式"（先 dryRun 展示 diff，确认后写入）→ 转换不了时改为"让管家转换"。编辑器右侧的"问管家"按钮：打开停靠面板，带上 workflow 和选中节点。风险卡：级别、证据链接、建议动作、稍后提醒 / 忽略。汇报卡：顶部摘要 + 四段。偏好与记忆：在管家页的设置抽屉里编辑信任档位、汇报时间、免打扰、关注 / 静音的空间、默认空间、harness 模型、浏览器通知，以及 `profile.md`。⌘K 输入匹配不到命令时，最后一项是"问管家：…" |
| **B 增删改** | `components/requirement-create/**`、`components/space-switcher.*`、`components/space-create/**`、`pages/spaces/**`、`pages/requirement/header*`（新拆出的页头）、`pages/requirements*.tsx` 中的主动作 | 新建需求对话框按设计文档 22 §2.1 实现：大文本框；标题自动取首行；标签行依次为流程（实时路由预览，带档位图形和理由，可改）、仓库、成员、预算、截止时间、链接；拖入附件；"创建后立即启动"开关；"让管家补全验收标准"逐条插入，每条可接受或拒绝；草稿保存在本地；⌘Enter 提交；提交后弹出带撤销的提示并跳转。需求页头部可以就地编辑标题、描述、负责人、截止时间，并提供归档、恢复、删除（只有没有运行记录的需求才能删）。切换器：走浮层原语，宽度 ≥ 280px，超过 5 个空间时出现搜索，同名时显示 id，底部是"新建空间"和"管理全部空间"，删掉 CLI 提示。新建空间对话框共三步：①名称、id（自动生成，实时校验唯一）、描述、颜色 ②起点卡片：空白 / 标准 / 快速 / 复制已有空间，复制时勾选要复制的部分 ③仓库和成员（可跳过）。单空间模式时说明原因，并给出 `ServerInfo.multiSpaceHint`。`/spaces` 页：空间卡片网格，显示需求数、进行中数、待办、风险、最近活动；支持重命名、改色、归档；已归档区可恢复、彻底删除（需输入 id 确认） |
| **C 知识库** | `pages/knowledge/**`、`pages/settings/knowledge-tab.tsx` | 列表页：卡片显示类型图标、状态、版本、规模、7 天用量、命中率、Recall@10，构建中的卡片有实时进度条；空状态展示类型卡片和"让管家帮我建"。新建向导共六步：类型 → 数据（每种类型一套表单，由 `configSchema` 生成并配专用控件：拖拽上传、仓库加 glob、连接串用密钥选择器（可就地新建密钥，只写不读）、OpenAPI 操作勾选）→ 测试 → 构建（分阶段进度、日志、取消）→ 检索测试 → 发布。详情页共七个 Tab：概览、数据源、构建、检索测试、评测、使用、设置。检索测试：输入问题，选择 intent 和 topK，在已发布和候选版本之间切换；结果显示分项得分条，可以展开原文，可以标注相关或不相关，标注写入评测集；database 和 api 类型显示实际执行的 SQL 或请求，以及拦截原因。评测：评测集按来源和状态展示；候选用例批量确认；"合成用例"和"采集线上用例"两个按钮；发起运行时可以加变体（版本或参数覆盖）；结果包含指标卡、逐用例诊断（四类诊断用不同标记）和对比结论。发布：先显示门槛结果，不通过时列出原因，强制发布需要填原因。空间设置的"知识库"Tab 改为只管绑定：启用、优先级、intents、角色，并链到详情页 |
| **D 体验重做** | `pages/{overview*,requirements*,attention}.tsx`（不含 B 负责的主动作）、`pages/run/**`、`pages/eval/**`、`pages/settings/**`（不含 knowledge-tab）、`pages/workflows-list*`、`components/{layout,topbar,stage-bar,stat-card,attention-card,event-*}.*` | 把体验基线落到这些页面上：统一页头和建议、骨架屏、空状态、错误状态、计数过渡、列表入场、新行闪烁、Tab 指示器。总览：统计卡片用 CountUp；"自上次以来"横幅（管家汇报的入口，数据用 `steward.digest`）；需求行显示风险标记。设置页各个 Tab 尽量做到"不改文件也能配"：用现有的写接口，没有写接口的就加一个"让管家帮我改"的入口。运行页和需求页的动效衔接：节点抽屉、阶段条、事件条 |

## 规则

- 只改自己名下的文件，名下目录里可以新建文件。
- 需要改共享文件时（`api/**`、`app.tsx`、`lib/**`、`components/ui/**`、`styles/**`），写进 knownIssues，交给汇总 agent。
- 后端在并行开发，各组只用 mock（`?mock=1`）。

**完成定义**：
- `npx tsc --noEmit -p packages/web` 里自己名下的文件没有错误；
- 最多 2 张压缩截图自检，以浅色为主。

## 汇总

1. 处理各组提出的共享改动和挂载问题。
2. 以下检查全部通过：
   - `npm run build -w @taktflow/web`；
   - `npm run motion:audit -w @taktflow/web`；
   - `npm run ux:audit -w @taktflow/web`；
   - `npx impeccable detect packages/web/src` 没有 P0 / P1。
3. 逐页检查体验基线，最多 10 张截图：
   - 管家整页；
   - 停靠面板（带提案）；
   - 新建需求对话框；
   - 新建空间对话框；
   - `/spaces`；
   - 知识库列表；
   - 知识库检索测试；
   - 知识库评测；
   - 总览；
   - 深色模式任选一页。
