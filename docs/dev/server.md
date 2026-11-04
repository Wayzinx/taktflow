# 开发简报：server（HTTP API + SSE）

**负责范围**：`packages/server/src/**`。依赖 `@taktflow/core`（存储与 insights 已实现，直接复用）。

**背景**：`packages/core/src/api.ts` 顶部的接口表就是你要实现的全部路由；`docs/design/11-项目总览与度量.md`。

## 要实现

导出 `createServer({ projectDir, port?, host?, webDir?, onAnswer? }): Promise<{ url: string; close(): Promise<void> }>`。

- 只用 `node:http`，不引入框架。写一个 30 行以内的小路由器（方法 + 路径模式 `:param`）。
- 启动时 `openProject(projectDir)` 拿到 ProjectStores；每个请求现读文件（CLI 进程可能同时在写），不做缓存。
- 路由逐条实现 api.ts 里的表格。要点：
  - `/api/project`、`/api/requirements`：RequirementSummary 的 stages 来自该需求最新一次运行（`runs.list({requirementId})` 按 startedAt 取最新）的 `stageProgress`；没有运行时阶段全部 todo（阶段定义来自那次运行的 workflow 快照；没有运行就返回空数组）。
  - `/api/runs/:runId`：RunDetail，graph 用 `buildRunGraph`。
  - `/api/runs/:runId/nodes/:nodeId`：NodeDetail。nodeId 里有 `/`，前端会做 encodeURIComponent，这里要 decode。prompt 从该节点的 `context.assembled` 事件 / harness 事件里取不到时，用快照里的静态 prompt。verdicts 来自 judge.verdict 事件；gate 来自 gate.result 事件；events 为该节点的全部事件。
  - `PUT /api/requirements/:id/artifact`：`writeArtifact`（author = `{type:'human', id: 请求头 x-takt-user 或 'web'}`，reason 必填，缺了 400），然后对该需求所有运行调用 stale 传播。引擎实例不在 server 进程里，所以 stale 传播由你在 server 里实现一个只读状态的版本：遍历运行的 state.json，NodeState.inputs 引用了该 path 的节点及其下游标 stale，写回 state.json 并追加 `node.stale` 事件；返回 staleNodes。
  - `/api/runs/:runId/stream`：SSE（`text/event-stream`），先推 `?after=` 之后的历史事件，再用 `events.subscribe` 推新事件；每 15 秒发注释行保活；连接关闭时取消订阅。
  - `POST /api/attention/:requestId`：调用 `attention.answer`，然后调用 `onAnswer?.(item)`（CLI 用它触发 resume）。
- `webDir` 存在时托管静态文件，未知路径回退 `index.html`（SPA）；`/api/*` 优先。
- CORS：允许 `http://localhost:5173`（vite dev）。
- 错误统一 `{ error, detail? }`，404 / 400 / 500 区分。

## 测试（vitest，临时目录里用 core 的存储造一个需求、一次运行、几条事件）

- 每个 GET 路由返回结构正确；
- PUT 产物：新版本 + 读过它的节点变 stale；缺 reason 返回 400；
- SSE：连接后能收到历史事件，再追加一条能实时收到；
- 静态托管与 SPA 回退。

## 完成定义

`npx tsc -b packages/server` 通过；`npx vitest run packages/server` 通过。
