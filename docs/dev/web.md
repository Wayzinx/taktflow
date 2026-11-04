# 开发简报：web（控制台）

**负责范围**：`packages/web/**`。可以为 web 包安装依赖（只在 `packages/web` 下，`npm install <pkg> -w @taktflow/web`），但保持克制：已预装 react 19、react-dom、@xyflow/react 12、lucide-react、vite、@vitejs/plugin-react。

**背景**：`docs/design/03-workflow即代码与DAG.md`（画布交互）、`04-公共存放区.md`、`07-上下文管理与可视化.md`、`11-项目总览与度量.md`；协议是 `packages/core/src/api.ts`（只 `import type`，不要在运行时引入 core）。

## 设计要求：美观、高级、有质感

这是项目的门面，开源用户第一眼看到的就是它。目标观感接近 Linear / Vercel / Raycast 这一档的工程工具：

- **克制的配色**：中性灰阶为主，一个主色（建议靛蓝或青绿）；状态色只用于状态（成功、运行、失败、等人、过期、跳过），饱和度适中。浅色和深色两套主题（跟随系统，可手动切换），全部用 CSS 变量定义 token。
- **排版**：系统字体栈（`-apple-system, "Inter", "PingFang SC", "Microsoft YaHei"`）+ 等宽字体显示 ID、路径、token；字号层级清楚，行高舒适，中文不挤。
- **细节**：1px 细边框和极淡的阴影代替粗分割线；8px 栅格；圆角统一（6/10px）；hover / focus 有细腻过渡（150ms）；运行中的节点有柔和的脉冲；空状态和加载骨架都要设计，不能出现裸的 "loading..."。
- **信息密度**：工程师工具，宁可紧凑清晰，也不要大面积留白；表格、数字右对齐、等宽数字（`font-variant-numeric: tabular-nums`）。
- 不用重型 UI 框架；样式用原生 CSS（CSS 变量 + 每个组件一个 `.css` 或 CSS Modules），不引入 Tailwind。图标用 lucide-react。

## 页面

布局：左侧窄导航（项目名、总览、需求、待办、知识源[占位]、设置[占位]）+ 顶部面包屑 + 主区。

1. **总览**（`/`）
   - 顶部 4 个统计卡：进行中、已交付、阻塞、本周 token / 成本；
   - 需求表：每行 ID、标题、负责人、**阶段条**（一串胶囊：已完成 ✓、进行中 旋转、等人 ⏸、失败 ✕、未开始 ○）、待办数、token；点击进入需求页；
   - 右侧或下方：待办列表（可直接审批 / 回答）。
2. **需求页**（`/req/:id`）
   - 头部：标题、状态、成员、外部链接、阶段条；
   - Tab：**公共产物** / **运行** / **追溯** / **度量** / **动态**。
   - 公共产物：二级分类按 ArtifactKind 分组（输入物料、Spec、系分、测试计划、用例、证据、报告、决策…）；左列表右预览；Markdown 渲染（自己写一个轻量渲染：标题、列表、代码块、表格、粗体、链接即可，不引大库）、JSON 高亮、图片预览；版本下拉（显示作者、时间、原因、来源节点）；"编辑"进入文本编辑，保存时必须填写原因，保存后提示有哪些节点因此变为过期（ArtifactEditResponse.staleNodes）；评论列表。
   - 运行：运行列表 → 点开进入运行页。
   - 追溯：**验收标准覆盖总览**（每条 AC 一张卡片：用例数、通过、未通过、未覆盖原因、覆盖状态标签）+ 追溯图（可以用 React Flow 简单分层布局）。
   - 度量：首跑可用率、Loop 轮次、人工介入、判决分布（横向条形）、token 按角色 / harness 拆分。用纯 SVG / CSS 画，不引图表库。
   - 动态：事件时间线。
3. **运行页**（`/run/:runId`）
   - 顶部：工作流标题、状态、耗时、token、阶段条；
   - **DAG 画布**（@xyflow/react）：自定义节点组件（图标区分 kind：script / agent / gate / human / judge / loop / planner；显示标题、角色·harness、状态色条、轮次角标、token）；按阶段分列布局（同一阶段的节点在一列，列头显示阶段名），列内按依赖拓扑排序；loop 体和 planner 展开节点用分组框（React Flow 的 group / parentId）包起来；边：实线依赖、虚线判决路由（带类别标签）、点线动态展开；支持缩放、小地图、适应视图。布局算法自己写（分层 + 列内排序），不引 dagre / elk。
   - 运行中通过 SSE（`/api/runs/:id/stream`）实时更新状态，节点状态变化有过渡。
   - **节点抽屉**（右侧滑出，可拖宽）：Tab = 概览（状态、耗时、尝试次数、harness/模型、usage、错误）/ 输入输出（产物版本，点开预览，可跳到需求页编辑）/ Trace（事件时间线：消息、工具调用可折叠、门禁结果、守卫违规）/ **上下文**（堆叠条按来源分色并标出预算线，超预算标红；明细表：来源、标题、引用、token、是否注入、原因；压缩记录时间线：前后 token 对比条 + 摘要 + 丢弃项）/ 判决（judge 节点：每条判决卡片：对象、类别标签、置信度条、理由、证据、修复类别、路由去向）/ 门禁（gate 节点：检查项列表、分数）/ Prompt（实际 prompt，等宽显示，可复制）。
4. **待办**（`/attention`）：全部待处理事项，按需求分组；approve / reject / 填写回答。

## 数据层

- `src/api/client.ts`：基于 fetch 的类型化客户端（类型来自 `@taktflow/core` 的 api.ts），base 为 `/api`；vite dev 下把 `/api` 代理到 `http://127.0.0.1:4870`。
- `src/api/mock.ts`：一套完整的**演示数据**（实现同样的接口），内容贴近 `docs/dev/cli-and-example.md` 里 hello-delivery 示例（需求 REQ-001"问候语支持空名字"、7 个阶段、dev-test-loop 2 轮、1 条 product_bug 判决、上下文快照与 1 次压缩、2 个 planner 展开条目、若干产物和版本），再加 2–3 个处于不同阶段的需求让总览好看。URL 带 `?mock=1` 或 `VITE_MOCK=1`，或者真实 API 不可达时，自动使用 mock 并在角落显示"演示数据"标记。
- 路由：自己写一个基于 `history.pushState` 的小路由（不引 react-router）。

## 自检（必须做）

1. `npm run build -w @taktflow/web` 通过（包含 `tsc --noEmit`）。
2. 用 `npx vite --port 5173`（后台）启动，然后用 Chrome 无头截图检查每个页面（浅色 + 深色）：
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --window-size=1440,900 --virtual-time-budget=4000 --screenshot=<绝对路径>.png "http://localhost:5173/?mock=1"`
   深色主题用 `?mock=1&theme=dark`（实现这个查询参数）。运行页和节点抽屉也要截图（抽屉可以用 `?mock=1&node=<nodeId>` 直接打开）。
3. **用 Read 工具查看每张截图**，以挑剔的设计师眼光自评：对齐、间距、层级、颜色、文字截断、重叠、空白、深色模式对比度。不满意就改，至少迭代两轮。截图保存在 `.taktdev/screenshots/web/`。
4. 结束前关闭你启动的 vite 进程。

## 交付说明

页面清单、组件结构、截图路径、已知不足。
