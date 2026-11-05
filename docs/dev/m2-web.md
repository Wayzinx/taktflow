# 开发简报：m2-web（用 impeccable 重做视觉与动效 + 项目空间 / 群聊 / 评审 / workflow 编辑器）

**负责范围**：`packages/web/**`，以及仓库根目录的 `PRODUCT.md`、`DESIGN.md`（impeccable 的上下文文件）。可以为 web 包安装依赖（`npm install <pkg> -w @taktflow/web`），保持克制。运行时只能 `import type` core。

**设计工具**：仓库已安装 impeccable（`.claude/skills/impeccable/`，含 `SKILL.md` 与各命令的参考手册；检测器 `npx impeccable detect`）。先完整读 `SKILL.md`，再按需读对应命令的参考文件（init、shape、critique、audit、typeset、layout、colorize、bolder、animate、delight、overdrive、polish、harden、onboard 等）。每个阶段结束都跑：
- `npx impeccable detect packages/web/src`（源码规则）；
- 起 vite 后 `npx impeccable detect http://localhost:5173/?mock=1`（渲染后规则：对比度、字号等）；
- Chrome 无头截图 + Read 自评（浅色 / 深色）。detector 的 P0/P1 必须清零。

**产品气质**：这是一个"AI 交付流水线"的控制台。目标是**有质感、高级、克制而有生命力**，像精密仪器的控制室，而不是又一个紫蓝渐变的 AI 落地页（impeccable 会把那类套路判为 slop）。品牌母题是 **takt（节拍）**：流水线按节拍推进。动效围绕这个母题设计，例如运行中的节点以稳定节拍脉动、数据流过的边有流动的光点、阶段条像传送带一样推进、Lead 回复逐字流出、抽屉与面板用弹簧物理。所有动效尊重 `prefers-reduced-motion`，不影响信息读取，不做无意义的装饰。

## 阶段 W1：设计系统与现有页面重做
1. 用 impeccable 的 init 流程写 `PRODUCT.md`（不要停下来问人：受众、用途、约束从 `README.md`、`docs/design/00-愿景与问题.md`、`11-项目总览与度量.md` 推断），再用 document 写 `DESIGN.md`（新的视觉系统：色彩 token、字体与字号阶梯、间距、圆角、阴影 / 质感、动效曲线与时长、图标规范、深浅两套主题）。
2. 先对现有页面做一次 critique 与 audit，记下问题清单（写进交付说明）。
3. 按新设计系统重做：全局外观（导航、顶栏、命令面板 ⌘K）、总览、需求页各 Tab、运行页（DAG 画布、节点卡片、边的动效、阶段条、抽屉）、待办、设置页。保持现有功能和数据层不变。
4. 自检通过后进入 W2。

## 阶段 W2：项目空间、需求群聊、评审
数据都先走 mock（`src/api/mock.ts` 补齐，贴近真实），协议见 `packages/core/src/api.ts` 新增的部分。
1. **项目空间**：左上角空间切换（`/api/spaces`）；URL 带空间前缀 `/s/:spaceId/...`（单空间时省略也能用）；空间设置页：成员、代码仓库（状态、同步按钮）、技能（列表 + SKILL.md 在线编辑，保存要写原因）、角色（同上）、workflow 列表（进入编辑器）、知识源、模型与 harness（原设置页并入）。
2. **需求群聊**：需求页新增"群聊"Tab（也可在右侧常驻展开）：成员列表（真人 / Lead / 子 Agent 区分）、消息流（文本、系统消息、待办卡片可直接审批、任务卡片显示子任务状态与产物、产物引用可点开）、输入框支持 @ 成员和 @lead、Lead 回复逐字流出、新消息实时到达（SSE `/api/requirements/:id/chat/stream`，mock 里用定时器模拟一段 Lead 对话和一个任务从派发到完成的过程）。
3. **评审**：节点抽屉新增"评审"Tab（review 节点）：轮次时间线（第 n / maxRounds 轮）、每个评审者的结论与分数、问题清单（严重程度、位置、描述、建议、作者回应：已修 / 不采纳 / 延后）、两轮之间的产物差异、打回重做记录；需求页新增"评审"Tab：所有评审节点的汇总（`ReviewSummary`）。DAG 上 review 节点显示轮次角标，打回边用专门的样式。
4. 事件时间线补齐 M2 事件的展示（review.*、rework.started、worktree.created、task.dispatched）。

## 阶段 W3：workflow 可视化编辑器
路由 `/s/:spaceId/workflows/:id`。数据：`GET/PATCH /api/workflows/:id`、`PUT .../source`、`PUT .../layout`、修订与回滚、SSE `.../stream`。mock 里在内存中维护 EditableWorkflow，按 WorkflowEdit 修改，并用一个简单的打印器生成源码文本用于代码视图。
1. 画布（React Flow）：阶段泳道、节点卡片（按 kind 区分）、连线即依赖（拖线 → setNeeds；删线同理）、拖动位置（PUT layout，防抖）、loop / planner 分组框。
2. 左侧节点面板：拖入新节点（addNode，按类型给默认属性），review 节点有专门的配置向导（作者、评审者、通过规则、轮次、打回目标）。
3. 右侧属性面板：字面量属性用表单（字符串、长文本 prompt、数字、开关、角色下拉、harness 下拉、阶段下拉、数组编辑）；代码值显示为只读高亮代码块，可切换为文本编辑（setProp 代码值）。
4. 顶栏：保存状态（基于 baseRev 的乐观锁）、撤销 / 重做（本地操作栈）、校验诊断（节点上就地标红）、修订历史抽屉（列表 + 与父修订的 diff + 回滚）、"源码"视图切换（只读高亮，或整文件编辑后 PUT source）。
5. 冲突：PATCH 返回 409 时弹出三方对比（base / 你的 / 对方的 / 合并结果），可选择覆盖或基于最新重做。
6. 协同：SSE 收到 `workflow.changed`（例如 AI 改了文件）时，画布上高亮变化的节点并提示"Lead / Agent 刚修改了 workflow"，可一键查看 diff。
7. `editable=false` 时画布只读，并显示原因。

## 自检（每个阶段）
`npm run build -w @taktflow/web` 通过；detector 无 P0/P1；截图（浅色 + 深色，`?mock=1`、`?mock=1&theme=dark`）存 `.taktdev/screenshots/m2-web/<阶段>/`，用 Read 逐张自评至少两轮。结束前关闭你启动的进程。

## 交付说明
每个阶段：做了什么、页面与组件清单、截图路径、detector 结果、已知不足、对后端接口的疑问（写成协议变更请求）。
