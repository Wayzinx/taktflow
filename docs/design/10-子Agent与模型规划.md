# 10 · 子 Agent：自定义角色 + 有边界的模型规划

## 解决什么问题

- 有的流程是确定的（澄清 → spec → 系分 → 用例），应该写死；有的事事先不知道要拆成几份（spec 拆成几个开发任务、失败要分给几个人修），应该让模型规划。
- 纯模型规划会失控：拆得太碎、角色乱选、不收敛。纯写死又不够灵活。

判据：结果确不确定、能不能回滚、出错代价高不高。确定、可回滚、代价高的用代码约束；探索性、要泛化的交给模型。

## 自定义角色

角色档案 `.takt/agents/<role>.md`：

```markdown
---
role: dev
title: 后端开发
harness: { harness: codex, effort: high, fallback: [{ harness: claude-code }] }
skills: [repo-conventions, api-client-reuse]
writeScope: ["src/**", "package.json"]
readScope: ["**"]
---
你是后端开发。只按 spec 和接口契约实现，不修改 tests/ 下任何文件……
```

- 用户可以新增任意角色（比如"安全评审""DBA""数据口径专家"），在 workflow 里用 `role: 'dba'` 引用。
- `writeScope` 是硬约束：引擎在节点结束后做 diff 校验；节点上的 `writeScope` 只能收窄角色的范围。
- 模板里自带 pm / architect / dev / test-designer / automation / judge / reviewer 七个角色。

## 有边界的模型规划：planner 节点

```ts
planner({
  id: 'split-tasks', title: '拆分开发任务', stage: 'loop', role: 'architect',
  needs: ['freeze'],
  prompt: '读 spec/ 和 design/，把实现拆成可独立交付的任务，每个任务给出 key、标题、依赖和建议角色',
  maxItems: 12,
  allowedRoles: ['dev', 'dev-fe'],
  expand: (item) => [
    agent({ id: 'implement', title: `实现：${item.title}`, role: item.role ?? 'dev', prompt: `实现任务 ${item.key}…` }),
    script({ id: 'selftest', title: '自测', needs: ['implement'], run: 'npm test' }),
    agent({ id: 'review', title: '评审', role: 'reviewer', needs: ['selftest'], prompt: '…' }),
  ],
})
```

- **模型决定"拆成哪些"**：planner 的 agent 按 schema 输出 `PlannedItem[]`。
- **代码决定"每个长什么样"**：`expand` 模板把每个条目展开成固定的子 DAG（实现 → 自测 → 评审）。
- **边界**：`maxItems` 上限、`allowedRoles` 白名单、条目依赖必须无环；超了引擎直接拒绝并记 `log`，而不是截断。
- 展开结果记 `dag.expanded`，画布上实时出现新节点。

## 和多 Agent 编排的关系

一个 workflow 里不同节点可以跑在不同 harness 上（09）；planner 展开的子任务互相隔离（各自会话、各自 writeScope），只通过公共存放区交换产物（04）。这就是"多 Agent 分工协作"的落地方式：**分工靠角色和 writeScope，协作靠存放区，不靠聊天**。
