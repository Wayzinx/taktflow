# 12 · MVP 范围与路线图

## M0 · 骨架（本次）

目标：**用 mock harness 端到端跑通一条示例流水线，CLI 能跑能查，Web 能看能改。**

| 模块 | 做到 |
|---|---|
| core | 类型契约、DSL + 静态校验、文件存储（存放区 / 事件哈希链 / 运行 / 待办）、DAG 引擎（script / agent / gate / human / judge / loop / planner）、写权限守卫、读模型（运行图、追溯图、度量） |
| harness | mock（剧本化）、claude-code、codex、dsh 适配器 |
| knowledge | grep / wiki / workspace / git-history + 路由器 |
| server | `packages/core/src/api.ts` 里列出的全部接口 + SSE |
| cli | `takt init / req new / ws put,get,ls,log / run / resume / answer / status / trace / audit verify / kb query / serve` |
| web | 项目总览、需求页（阶段条 + 公共产物 Tab + 版本 + 编辑）、运行页（DAG 画布 + 节点抽屉：输入输出 / Trace / 上下文 / 判决 / 门禁）、待办 |
| 模板 | `sdlc.workflow.ts`（默认流水线）、7 个角色档案 |
| 示例 | `examples/hello-delivery`：一个小需求，mock 剧本里故意让一条用例失败，演示判决 → 路由 → 修复 → 通过 |

验收：`npm run build && npm test` 通过；`takt run` 跑完示例并产出完整的 `.takt/`；`takt serve` 后 Web 能看到需求、阶段、DAG、节点详情、上下文账本、判决；`takt audit verify` 通过。

## M1 · 真跑起来

- 扩展性第一批（[13](13-扩展性与生态.md)，简报 `docs/dev/extensibility.md`）：ModelProvider（openai-chat / anthropic-messages + 国内外厂商预设）、native harness、声明式 CLI 适配、Gemini / Cursor / Qwen / Kimi / OpenCode 适配器、插件加载、`takt doctor`、一致性测试套件、Web 设置页；

- 用真实 harness（Claude Code / Codex / DeepSeek）跑一个真实小需求；
- 修复准入 validator V2–V5；
- 外部导入：飞书文档、Meego 需求；
- 上下文预算策略和压缩前钩子；
- 知识层：CodeGraph、数据库只读源。

## M2 · 项目空间与协作（进行中）

- 项目空间（[14](14-项目空间.md)）：成员、绑定多个代码仓库、空间级技能 / 知识 / 角色 / workflow，多空间 serve；
- 需求群聊与 Lead Agent（[15](15-需求群聊与Lead-Agent.md)）：内置 Web 群聊、动作 JSON、临时任务运行、IM 适配接口；
- workflow 协同编辑（[16](16-工作流协同编辑.md)）：受限子集解析、AST 最小替换、画布拖拽编辑、修订 / 合并 / 回滚；
- 沙箱与部署（[17](17-文件系统与沙箱.md)）：local / bwrap / docker 三档沙箱、代码仓库 worktree、Linux CI、Dockerfile；
- 评审机制（[18](18-评审机制与默认流水线.md)）：review 节点、打回重做、作者版标准流水线；
- Pi 适配器；Web 用 impeccable 重做视觉与动效。

## M3 · 团队规模化

- 服务端模式（多人共用一个 `.takt/`）、权限；
- 需求级成员和评论通知；
- 判决评测集与混淆矩阵；
- 多 harness 组合评测（控制变量、多次运行、成对比较）。

## M4 · 生态

- workflow / 角色 / 知识源 / harness 插件化发布与安装；
- 导入 spec-kit、BMAD 的产物作为公共存放区输入；
- 托管运行与触发器（issue 事件、定时）。
