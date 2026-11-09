# 开发简报：M8 后端 C5（续跑"开始了就返回"：回答待办、继续运行不再挂住请求）

**先读**：`AGENTS.md`、`docs/dev/m8-backend-c4.md`（上一轮：运行租约）、`packages/core/src/engine/index.ts`、`packages/core/src/lead/index.ts`（`launch`、`resume_run`）、`packages/cli/src/command-runtime.ts`（`answerAttention`、`resumeRun`）、`packages/cli/src/commands/serve.ts`（`onSpaceAnswer`、`resumeAfterAnswer`）、`packages/server/src/routes.ts`（`POST /api/attention/:requestId`）。

**协议**：本轮只改 `Engine.resume(runId, workflow, opts?: { onStarted?: () => void })`（已写好，在 `interfaces.ts`）。不要再改 `packages/core/src/{types,interfaces,api}.ts`。

**通用要求**：中文错误信息、不调用付费模型、不发真实网络请求、三个 demo 不变红。**不要动 `packages/web/`**。本机 4870 端口有 serve，另有一个 `takt resume` 进程在跑真实运行，不要停它们、不要发请求、不要碰 `~/taktflow-playground`。

---

## 背景（真实发生的）

- **回答待办会挂住请求。** 网页上回答一个人工节点：
  1. `POST /api/attention/:id` 先执行 `attention.answer` 命令；
  2. 命令里 `answerAttention` 在 lead 不接手时 `await execute({ type: 'resume_run' })`；
  3. `resume_run` 又 `await engine.resume(...)`，要等运行跑到**下一个人工节点或结束**才返回；
  4. 之后路由里还会 `await onAnswer?.(item)` → serve 的 `resumeAfterAnswer` 再 `resumeOnce` 一次。

  真实运行里一个节点能跑一两个小时，脚本回答待办时 HTTP 超时（3600 秒）。网页上点"提交"也会一直转圈。
- **界面上的"继续运行"**（`run.resume`，上一轮让中断的运行可续跑）同样会挂到运行停下。
- `start_run` 已经是"创建好就返回"（`launch` 的 `ready`），续跑应该同样处理。

## 任务 1：引擎 `resume` 支持 `onStarted`

- 在拿到运行租约、找到状态、workflow 与 harness 校验都通过、即将进入执行循环时调用一次 `opts.onStarted?.()`。
- 在这之前抛出的错误（租约被活进程占着、运行不存在、workflow 不匹配、harness 校验失败）照常让 Promise reject。
- `onStarted` 抛错不能影响运行。

## 任务 2：一个共用的"后台续跑"

在 core 里写一个小函数（名字自定），用法类似：

```ts
await resumeInBackground(() => engine.resume(runId, workflow, { onStarted }), { onError, onSettled })
```

- **返回时机**：`onStarted` 被调用就 resolve；在那之前 reject 就把错误抛给调用方。
- **执行**：运行本身在后台继续。之后出的错交给 `onError`，例如在需求群聊里发一条"运行失败：…"，与 `launch` 一致，不能变成未处理的 rejection。
- **结束**：运行结束（任何结果）时调用 `onSettled`，用于 `recordTaskImpact`、`refreshPresence`、`engines.delete` 等与 `launch` 对齐的收尾。
- **关闭**：lead 现有的 `jobs` 集合要能追踪这些后台续跑，`close` 时等它们结束，与 `launch` 一致。

## 任务 3：所有续跑入口改成"开始了就返回"

- `lead` 的 `resume_run`（含 `task:` 运行的 `resumeTask` 分支）。
- `command-runtime.ts` 的 `answerAttention`：回答写入后触发续跑，开始了就返回。
- `serve.ts` 的 `onSpaceAnswer` / `resumeAfterAnswer` 与 `routes.ts` 的 `onAnswer`：现在命令里已经续跑一次，路由里又续跑一次。**理清只保留一条续跑路径**，删掉重复的那条，不能出现同一次回答触发两次 resume。上一轮的租约会让第二次报"运行正在由进程执行"，现在可能被吞掉或冒成 500。
- CLI 前台命令 `takt resume` / `takt run` 保持现状：前台等到运行停下再退出，这是命令行的预期。

## 任务 4：测试

- 用一个会"卡住"的 mock harness（例如等一个测试里手动 resolve 的 Promise）：
  - `POST /api/attention/:id` 在节点还在跑时就返回 200，且只触发一次 resume（spy 计数）；
  - `run.resume` 命令对中断的运行同样立即返回，运行在后台推进，最后能跑完。
- 开始前的错误：租约被活进程占着时 `run.resume` 报错（不是 200）。
- 开始后的错误：harness 在节点里抛错时，HTTP 已经 200，群聊里有"运行失败"消息，进程没有未处理的 rejection。
- 现有回答待办、续跑相关测试全部保持通过（必要时把"等到运行结束"的断言改为轮询等状态）。

## 交付

交付说明只写在最终输出里（做了什么、测试结果、没做什么、已知问题），不要在源码目录放文档。不提交、不推送。
