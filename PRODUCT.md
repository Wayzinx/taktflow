# Product

<!-- impeccable:product-schema 1 -->

> 本文件由 impeccable init 流程写成。执行时没有可交互的提问通道（被调度的子 Agent），以下事实全部**从仓库推断**：`README.md`、`docs/design/00-愿景与问题.md`、`11-项目总览与度量.md`、`14`–`18` 与 `docs/dev/m2-web.md`。标注 *[推断]* 的条目请负责人确认。

## Platform

web

## Users

- **研发 / 测试 / 产品负责人（主要用户）**：一个需求的负责人。白天在桌面浏览器里开着控制台，盯自己负责的几个需求走到哪一站、卡在哪；在评审卡点、判决交人、预算用尽时被叫进来做决定（审批、回答、裁决），然后让流水线继续。*[推断：来自 00「人看例外，不看全部」与 11 的待办设计]*
- **团队管理者**：一眼看到所有需求的阶段、阻塞、待办和 token / 成本，不必再问人"做到哪了"。
- **流水线作者（平台 / 效能工程师）**：维护项目空间里的 workflow、角色、技能、harness 与模型配置；在画布上拖拽，或让 AI 直接改 `.workflow.ts`。

使用场景是办公室或居家的桌面大屏，长时间常驻标签页，浅色、深色都会用（跟随系统）。偶尔在手机上查看进度和处理待办。

## Product Purpose

taktflow 是一条"按节拍走"的 AI 交付流水线：需求进来，多个 Agent 按代码定义的 DAG 分工完成澄清、设计、编码、测试、判决修复和准出；每个节点的输入、产物、上下文和判决都落盘、可追溯、可审计、可人工修改后重跑。

Web 控制台是这条流水线的观察与干预面：看清每个需求在哪一站、每个节点用了什么上下文、为什么失败、谁在等谁；在需要人的地方让人快速做出决定。成功的标准是：人只在例外处出现，出现时信息就在手边，几秒内能做决定。

## Positioning

- **验证优先**：调度完成（COMPLETED）≠ 业务通过（PASS）。失败先交给判决 Agent 归因（代码 / 用例 / 脚本 / 环境 / 需求），再路由给对的角色修。
- **全程留痕**：事件日志哈希链、产物溯源、需求 → AC → 用例 → 证据 → 判决的追溯图；评审的每一轮、每条意见、作者的每条回应都可回看。
- **流程即代码**：`.workflow.ts` 是唯一事实源，画布和 AI 改的是同一个文件。
- **多 harness × 多模型**：Claude Code、Codex、OpenCode、Pi、DeepSeek Harness 等按角色和节点选择、可降级。

## Operating Context

- 部署：本地 `takt serve`（默认 `http://127.0.0.1:4870`），生产大概率在云端 Linux / 容器；Web 是同一个 server 下发的单页应用。
- 层级：项目空间 → 需求 → 运行 → 节点。每个需求有公共存放区（PRD、spec、系分、用例、证据、评审记录、报告）、需求群聊（真人 + Lead Agent + 子 Agent）、运行记录。
- 默认流水线阶段：需求理解 → 系分设计 → 测分设计 → 对齐冻结 → 研发 → 研发测试 Loop → 影响面评估 → 准出。PRD、系分、测分、代码都要交叉评审，评审有轮次上限与打回。
- 外部系统：Meego / Jira（需求同步）、飞书（原文链接）、git 代码仓库。

## Capabilities and Constraints

- 前端：React 19 + React Flow（`@xyflow/react`）+ lucide-react + Vite，路由是自写的极简 history 路由；数据层是 `/api` + SSE，`?mock=1` 用内置演示数据。运行时只能 `import type` core。
- 节点类型：script、agent、gate、human、judge、loop、planner、review、subflow。节点状态：pending、ready、running、succeeded、failed、blocked、waiting_human、skipped、stale、cancelled。
- 判决类别：代码缺陷、用例缺陷、脚本缺陷、环境问题、不稳定、需求缺口、无法判定。
- 术语是中文为主，标识符（REQ-001、run id、文件路径、角色名、模型名）保持原文等宽显示。
- 未定：多空间的权限模型在 UI 上如何呈现、外部 IM（飞书 / Slack）群聊的同步样式。

## Brand Commitments

- 名字 **taktflow**，小写。母题 **takt（节拍）**：精益生产流水线的节拍，每一站按规范产出，过了门禁才流向下一站。*[来自 00 与 m2-web 简报]*
- 气质（简报明确给出）：有质感、高级、克制而有生命力，像精密仪器的控制室；**不是**又一个紫蓝渐变的 AI 落地页。动效围绕节拍：运行中的节点按稳定节拍脉动、数据流过的边有流动的光点、阶段条像传送带推进、Lead 回复逐字流出、抽屉与面板用弹簧物理。
- 语言：中文界面，直接、具体，像工程师之间的交接，不用营销词。

## Evidence on Hand

- 演示数据：`packages/web/src/api/mock-data.ts`（hello-delivery 项目，6 个需求、多次运行、判决、评审、度量），标注为"演示数据"。
- 示例项目：`examples/hello-delivery`；默认流水线模板：`templates/workflows/`。
- 没有真实客户、用户量、基准数据或证言；不得编造。

## Product Principles

1. **状态先于装饰**：每一处颜色和动效都在说明一个真实状态（运行、等人、失败、过期），没有状态就保持安静。
2. **COMPLETED ≠ PASS**：界面上"通过"只来自门禁、评审和用例结论，绝不由节点成功推断。
3. **人看例外**：待办、判决交人、评审打回永远在最显眼、最少点击的位置。
4. **一切可追溯**：任何结论都能一步点到它的依据（产物版本、事件、评审意见、证据）。
5. **人和 AI 改同一份东西**：workflow、产物、群聊里的修改都留痕，界面要让"谁、为什么、改了什么"一眼可见。

## Accessibility & Inclusion

- 文本对比度满足 WCAG AA；状态不只靠颜色区分（同时有图标或文字）。
- 所有动效尊重 `prefers-reduced-motion`；键盘可达（命令面板、Tab、抽屉 Esc 关闭）。*[推断：来自 m2-web 简报]*
