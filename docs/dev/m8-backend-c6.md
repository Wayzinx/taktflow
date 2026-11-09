# 开发简报：M8 后端 C6（重试失败的节点，不必整个运行从头来）

**先读**：`AGENTS.md`、`docs/dev/m8-backend-c5.md`（上一轮：后台续跑、开始了就返回）、`packages/core/src/engine/index.ts`、`packages/core/src/engine/runtime.ts`、`packages/core/src/lead/index.ts`、`packages/core/src/commands/`、`packages/cli/src/index.ts`。

**协议**（已写好，不要再改 `packages/core/src/{types,interfaces,api}.ts`）：

- `Engine.retry(runId, workflow, opts?: { nodeIds?, reason?, onStarted? })`；
- `LeadAction` 加 `{ type: 'retry_run'; runId; nodeIds? }`；
- 事件 `run.retried: { nodeIds; reason? }`。

**通用要求**：中文错误信息、不调用付费模型、不发真实网络请求、三个 demo 不变红。**不要动 `packages/web/`**。本机 4870 端口有 serve，不要停它、不要发请求、不要碰 `~/taktflow-playground`。

---

## 背景（真实发生的）

真实运行里 `review-prd` 节点因为一个引擎 bug（作者回应用了全局编号，已修）失败，整个运行变成 `failed`。修好后想接着跑：

- 界面上的 `run.resume` 被拒："已终结运行不能继续"；
- 命令行 `takt resume` 进了引擎，但失败节点不会重跑，运行立刻又以 `failed` 结束。

前面三个节点（澄清、回答、PRD，约 30 分钟模型时间）只能全部重来。需要"重试失败的节点"。

## 任务 1：引擎 `retry`

- **前置条件**：运行状态是 `failed`，或者是 `running` / `waiting_human` 但有节点处于 `failed` / `blocked`。`succeeded`、`cancelled` 报"已成功或已取消的运行不能重试"。
- **要重试的节点**：`opts.nodeIds` 给了就只重试这些，每个都必须是 `failed` 或 `blocked`，否则报错并列出不合格的节点；没给就重试全部 `failed` 和 `blocked` 节点。一个都没有时报"没有失败或阻塞的节点可以重试"。
- **状态怎么改**：
  - 重试的节点改为可调度。这些节点的下游里，因它们失败而 `skipped` / `cancelled` 的也要恢复为 `pending`，按现有调度规则重新就绪。
  - 运行状态改回 `running`，清掉 `endedAt`。
  - 记一条 `run.retried` 事件（`nodeIds`、`reason`，actor 为发起人）。
  - 然后走与 `resume` 相同的执行路径：拿租约、`onStarted`、执行循环。
- **节点内部进度**：review 节点的 `progress`（轮次、问题、阶段）保留，从失败时所在阶段接着跑。例如本例停在 `revise`，就重新让作者回应本轮。`attempts` 加 1。其他节点类型按现有"重新开始一次尝试"的语义处理，复用 `restarting` / stale 重跑那套机制，别另起一套。
- **租约 / 后台**：与上一轮一致；在 serve 里走后台续跑（开始了就返回）。

## 任务 2：入口

- `lead` 的 `retry_run` 动作。
- 命令 `run.retry`：输入 `{ runId, nodeIds? }`，风险 `write`，需要原因（进审计）。在命令注册表里登记，与 `run.resume` 同级。
- CLI `takt retry <runId> [--node <id> ...]`，与 `takt resume` 同样前台跑到停下。
- 已结束运行的"自动化"事件（`run.failed` 已经发过）不需要撤回；重试后再次结束会再按状态派发一次。

## 任务 3：测试

- 节点失败 → `run.retry` → 该节点重跑成功 → 运行继续到结束（mock harness 第一次抛错、第二次成功）。
- review 节点停在 `revise` 失败后重试，从 `revise` 接着跑，不重新评审。
- `nodeIds` 指定非失败节点时报错；`succeeded` 运行重试报错；没有可重试节点时报错。
- `run.retried` 事件进哈希链，`verify` 通过。
- serve 路由：`POST /api/commands/run.retry` 开始了就返回 200。

## 交付

交付说明只写在最终输出里（做了什么、测试结果、没做什么、已知问题），不要在源码目录放文档。不提交、不推送。
