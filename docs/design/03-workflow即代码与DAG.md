# 03 · Workflow 即代码，DAG 可视化

## 解决什么问题

- 纯 Skill / 提示词定义的流程，模型可能不遵守；YAML 定义的流程，复用和动态逻辑写起来别扭。
- 流程长了以后，没人能一眼看出"现在卡在哪一步、为什么卡"。

## 怎么做

**代码定义，画布展示。** 流程用 TypeScript 写（`packages/core/src/dsl.ts`），引擎把定义 + 运行状态 + 动态展开合成一张图（`RunDetail.graph`），Web 用 React Flow 画出来。画布只读结构、可操作节点（重跑、看详情、改产物），不支持拖拽改结构，结构改动走代码评审。

```ts
import { defineWorkflow, agent, gate, human, judge, loop, planner, script } from '@taktflow/core'

export default defineWorkflow({
  id: 'sdlc', title: '标准交付流水线', version: '0.1.0',
  stages: [
    { id: 'understand', title: '需求理解' }, { id: 'design', title: '系分设计' },
    { id: 'test-design', title: '测分设计' }, { id: 'loop', title: '研发测试 Loop' },
    { id: 'impact', title: '影响面评估' }, { id: 'report', title: '质量报告' },
  ],
  nodes: [
    agent({ id: 'clarify', title: '需求澄清', stage: 'understand', role: 'pm',
      inputs: [{ path: 'inputs/**' }], outputs: [{ path: 'spec/clarify.md', kind: 'clarification' }],
      prompt: '读 inputs/ 下的 PRD 和纪要，列出待确认问题' }),
    human({ id: 'answer', title: '回答澄清问题', stage: 'understand', needs: ['clarify'], ask: '…', form: 'answer' }),
    // …
  ],
})
```

## 节点类型

| kind | 用途 | 谁执行 | 典型例子 |
|---|---|---|---|
| `script` | 确定性的事 | shell / TS 函数 | 跑测试、校验 schema、打包、导入飞书文档 |
| `agent` | 需要判断和生成的事 | harness（按角色选） | 澄清、写 spec、系分、写代码、写用例 |
| `gate` | 门禁：一组检查，fail-closed | 命令 / 函数 / rubric（LLM 打分） | AC 全部有用例、契约可执行、覆盖率 ≥ 85% |
| `human` | 人工卡点 | 人（CLI 或 Web） | 审 spec、回答澄清问题、准出验收 |
| `judge` | 失败归因并路由 | harness（判决角色） | 用例失败 → 代码 / 用例 / 脚本 / 环境 / 需求问题 |
| `loop` | 子 DAG 重复执行直到收敛 | 引擎 | 研发测试 Loop：执行 → 判决 → 修复 → 再执行 |
| `planner` | 模型规划子任务，代码决定子任务形状 | harness + 模板 | 把 spec 拆成 N 个开发任务，每个任务展开成"实现 → 自测 → 评审" |
| `subflow` | 复用另一个 workflow | 引擎 | Bug 修复流程、影响面分析流程 |

## 调度规则

1. 依赖全部 `succeeded`（或 `skipped`）的节点变成 `ready`；并发上限可配。
2. 节点失败按 `retry.max` 重试，重试时把上一次的结构化报错带进 prompt（不是盲目重来）。
3. `gate` 不通过：`onFail: 'stop'` 停在这里；`'human'` 进待办，人可以"放行并写理由"或"打回"。
4. `human` 节点让运行进入 `waiting_human`；回答后 `takt resume` 继续，已完成节点直接复用结果。
5. `planner` 展开的节点记一条 `dag.expanded` 事件，画布上画在 planner 下面；展开有 `maxItems` 上限，角色必须在 `allowedRoles` 里。
6. 公共存放区里的产物被人改了，读过它的节点及下游变成 `stale`，人决定是否重跑（业界常见做法是"所有改动必须走插件"，我们换成"改了就自动标记影响面"）。

## 画布交互（Web）

- 节点颜色 = 状态；角标 = 角色 / harness / 轮次；边：实线依赖、虚线判决路由、点线动态展开。
- 点节点打开抽屉：**概览**（状态、耗时、token）/ **输入输出**（产物版本，可点开、可编辑）/ **Trace**（事件时间线、工具调用）/ **上下文**（堆叠条 + 压缩记录）/ **判决**（judge 节点）/ **门禁**（gate 节点）。
- 运行中通过 SSE 实时刷新。
