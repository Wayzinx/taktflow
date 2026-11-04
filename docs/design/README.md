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

## 参考资料

- 原型：[browser-nav-assistant](https://github.com/Wayzinx/browser-nav-assistant) 的 `.workflow/browser-nav-sdlc.workflow.js` 与 `CONVENTIONS.md`。
- 视频：皮皮虾说《公司正式宣布开始 AI 自动化实现需求》（BV1Rex26dEWF）：物料仓库、spec → task → 门禁 DAG、全程留痕与度量。
- 常见的需求协作平台：阶段条 + 公共产物分类 + 共享上下文的 Agent 任务。
