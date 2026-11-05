# 设计文档

每篇回答三个问题：**解决什么问题、怎么做、MVP 做到哪**。改协议（`packages/core/src/types.ts / interfaces.ts / api.ts`）之前先改这里。

| # | 文档 | 一句话 |
|---|---|---|
| 00 | [愿景与问题](00-愿景与问题.md) | 规范、可度量、可审计的 AI 交付线；7 个要解决的问题和设计原则 |
| 01 | [竞品对比](01-竞品对比.md) | spec-kit / BMAD / superpowers / Archon / 原型 workflow 逐项对比，以及我们的定位 |
| 02 | [总体架构](02-总体架构.md) | 分层、包职责、`.takt/` 目录布局、一次运行的时序、关键取舍 |
| 03 | [Workflow 即代码与 DAG](03-workflow即代码与DAG.md) | TS 定义流程、8 种节点、调度规则、画布交互 |
| 04 | [公共存放区](04-公共存放区.md) | 每个需求一个共享目录：所有 Agent 和人从这里取、往这里写；版本、溯源、影响面 |
| 05 | [判决 Agent 与研发测试 Loop](05-判决Agent与修复Loop.md) | 失败先归因再路由；防假修复的 V1–V6；生成者和验证者隔离 |
| 06 | [追溯与审计](06-追溯与审计.md) | 产物溯源、哈希链事件日志、追溯图、人工修改 |
| 07 | [上下文管理与可视化](07-上下文管理与可视化.md) | 拆、落盘、隔离；上下文账本与压缩记录 |
| 08 | [存量项目知识层](08-存量项目知识层.md) | 按问题类型路由到 rg / Wiki / CodeGraph / DB / 接口 / git 历史；知识回流 |
| 09 | [多 harness 与模型路由](09-多harness与模型路由.md) | harness × 模型两层正交、降级链、默认角色分工 |
| 10 | [子 Agent 与模型规划](10-子Agent与模型规划.md) | 自定义角色 + 有边界的 planner 动态展开 |
| 11 | [项目总览与度量](11-项目总览与度量.md) | 总览、需求页、运行页；度量全部从事件日志计算 |
| 12 | [MVP 范围与路线图](12-MVP范围与路线图.md) | M0 骨架验收标准，M1–M3 |
| 13 | [扩展性与生态](13-扩展性与生态.md) | 五个扩展点、三种 harness 接入方式、harness 与 LLM API 支持矩阵、插件与密钥 |
| 14 | [项目空间](14-项目空间.md) | 比代码仓库高一层的容器：成员、绑定仓库、技能、知识、角色、workflow、需求 |
| 15 | [需求群聊与 Lead Agent](15-需求群聊与Lead-Agent.md) | 每个需求一个群；Lead 用"回复 + 动作"驱动流水线、派发临时任务，全部留痕 |
| 16 | [workflow 协同编辑](16-工作流协同编辑.md) | `.workflow.ts` 受限子集是唯一事实源；画布做 AST 最小文本替换，AI 直接改文件；修订与合并 |
| 17 | [文件系统、沙箱与部署](17-文件系统与沙箱.md) | 空间 / 仓库镜像 + worktree / 对象存储；local、bwrap、docker 三档沙箱；Linux 与容器部署 |
| 18 | [评审机制与默认流水线](18-评审机制与默认流水线.md) | review 节点：交叉评审、独立上下文、轮次上限、打回重做、全程留痕；作者版标准流水线 |
| 19 | [外部参考与改进](19-外部参考与改进.md) | 分档路由、完成标准防假完成、失败指纹、评审修订与正交状态、审批绑定版本、交付校验与拦截度量、命令注册表、预算、经验库、动效规范 |

## 参考资料

- 原型：[browser-nav-assistant](https://github.com/Wayzinx/browser-nav-assistant) 的 `.workflow/browser-nav-sdlc.workflow.js` 与 `CONVENTIONS.md`。
- 视频：皮皮虾说《公司正式宣布开始 AI 自动化实现需求》（BV1Rex26dEWF）：物料仓库、spec → task → 门禁 DAG、全程留痕与度量。
- 常见的需求协作平台：阶段条 + 公共产物分类 + 共享上下文的 Agent 任务。
- [Metis](https://github.com/Wholiver/metis)：按改动形状分档、门禁由运行时记账、失败指纹、自学习软层；`docs/ale-metis-agent-failure-modes.md` 的失败分析。
- [OpenBitFun](https://github.com/GCWing/OpenBitFun)：`docs/sdlc-harness/`、`docs/architecture/review-lifecycle.md`（评审记录 / 修订 / 正交状态）、`src/web-ui/MOTION_AUDIT.md`（动效审计）。
