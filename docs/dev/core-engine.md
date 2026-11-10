# 开发简报：core-engine（DAG 引擎）

**负责范围**：`packages/core/src/engine/**`，以及在 `packages/core/src/index.ts` 追加导出。存储层（`store/`、`insights/`、`util/`）已由 core-store 完成，直接复用，不要重写；发现存储层 bug 可以修，但要在交付说明里列出。

**背景**：先读 `docs/design/03-workflow即代码与DAG.md`、`05-判决Agent与修复Loop.md`、`07-上下文管理与可视化.md`、`10-子Agent与模型规划.md`，以及 `types.ts` 里每种 NodeDef 的注释，和 `templates/workflows/sdlc.workflow.ts`（引擎必须能跑这个模板）。

## 要实现：`createEngine(deps: EngineDeps, opts?: { concurrency?: number; now?: () => Date; harnessOverride?: string; autoApprove?: boolean }): Engine`

- `harnessOverride`：所有 agent / judge / planner / rubric 调用强制使用这个 harness（演示和 CI 用 mock）。
- `autoApprove`：human 节点和 onFail=human 的门禁自动以 actor `{type:'human', id:'auto-approve'}` 回答 approve（answer 表单回答"（自动通过）"），照样记 human.requested / human.answered 事件，仅用于演示和 CI。

### 调度
- start：写 RunState（status running）+ `runStore.create(state, snapshotWorkflow(def))` + `run.started`；然后调度循环：所有依赖 succeeded/skipped 的 pending 节点 → ready → 执行（并发上限默认 4）。
- 依赖失败的节点保持 pending；没有可运行节点时：有 waiting_human → 运行 status=waiting_human 并返回；有失败 → failed；全部完成 → succeeded。结束写 `run.finished`。
- resume(runId, def)：读 state；对 waiting_human 节点检查 attention 是否已回答（approve→succeeded、reject→failed、answer/choice→succeeded，result = { decision, answer }），然后继续调度。已 succeeded 的节点不重跑。
- cancel：status=cancelled，运行中的 harness 用 AbortSignal 取消。
- markStale(runId, cause)：NodeState.inputs 里引用了 cause.path 的节点及其所有下游 → stale，记 `node.stale`。
- 每次状态变化都 save state；每个节点生命周期发事件（node.ready / node.started / node.finished / node.failed）。重试按 retry.max，重试时把上次错误附在 prompt 末尾（"上一次失败原因：…"）。

### NodeContext
按 types.ts 实现；`resultOf(id)` 先在当前作用域（loop 体 / planner 条目）找，再找顶层；`readArtifact(path)` 读存放区最新内容。

### 各类节点
- **script**：字符串命令用 `child_process.spawn('sh', ['-c', cmd])`，cwd=projectDir，env 加 `TAKT_RUN_ID / TAKT_REQ / TAKT_WORKSPACE / TAKT_NODE`；退出码 0 成功；stdout/stderr 末尾 4KB 记 log 事件。函数直接调用，返回 NodeResult。
- **agent**：
  1. 解析 role → AgentProfile（不存在则报错）；harness 选择优先级：节点 harness > profile.harness > config.roles[role] > `{ harness: 'mock' }`；按 fallback 链依次 `available()`，可重试错误（结果 error 含 429/503/401/sign in/timeout）换下一个，每次切换记 log。
  2. 预取知识：`node.knowledge` 每条按 intent 选 `knowledge` 里 intents 包含它的源，命中写进上下文，记 `knowledge.query`。
  3. 组装上下文账本（ContextSnapshot）：role 说明、inputs 解析到的存放区文件（按声明顺序内联全文，最多占预算的一半（余量留给 harness 自带提示、运行中读的文件），放不下的只给路径并记 `included: false`）、知识命中摘要、prompt；预算 = config.contextBudgetTokens ?? 200000；记 `context.assembled` 并 `runs.saveContext`。
  4. 渲染最终 prompt：角色说明 + 任务 prompt + 「公共存放区：<绝对路径>，需要读的文件：…，需要产出的文件：…，写权限：…」+ 有 resultSchema 时要求最后输出一个 ```json 代码块。
     调用 harness 时 `req.env` 必须带 `TAKT_ROLE`、`TAKT_NODE`、`TAKT_WORKSPACE`、`TAKT_RUN_ID`、`TAKT_TRANSCRIPT`（= runs/<RUN>/transcripts/<nodeId>.jsonl），cwd = projectDir。
  5. 写权限守卫：执行前对 projectDir 做文件快照（listFiles + sha），执行后再快照，变化的文件不匹配 writeScope（节点 writeScope ∩ profile.writeScope；`.takt/workspaces/<REQ>/**` 下产物路径相对 projectDir 计算）→ 记 `guard.violation`。项目是 git 仓库时对越界的已跟踪文件 `git checkout -- <file>`、对新增文件删除（action=reverted），否则 action=flagged；有违规节点记 blocked。
     并发注意：多个节点同时运行时，变化的文件只要匹配**任一**同时在运行的节点的写权限就不算当前节点越界；引擎自己写的文件（`.takt/runs/**`、`.takt/objects/**`、存放区的 `manifest.json / requirement.json / comments.jsonl`、`.takt/attention.jsonl`）不参与守卫。
     `.takt/worktrees/**` 单独按文件元数据缓存哈希：无 repo 节点不能写，有 repo 节点仅允许自己的工作树并由 cwd 守卫检查范围；`.git` 与受控系统写入排除，其他工作树的违规按项目相对路径报告。
  6. harness 事件实时转成 `harness.*` / `context.compacted` 事件；usage 写 NodeState.usage。
  7. resultSchema：从 finalText 最后一个 ```json 代码块解析，做最小校验（type / required / properties / items / enum，写在 `engine/schema.ts`）。
- **gate**：依次执行 checks：command（退出码 0 = pass，message 为输出末尾）、function、rubric（用 role 的 harness 跑一次，要求输出 `{ score, pass, message }`，score ≥ threshold 才 pass）。检查本身抛错 = 不通过（fail-closed）。记 `gate.result`；全过 succeeded；否则 onFail=stop → failed，onFail=human → 创建 attention（ask 附上失败检查），waiting_human。
- **human**：创建 attention（requestId = `${runId}:${nodeId}`），记 `human.requested`，节点 waiting_human。
- **judge**：读 target 结果 `failures`；为空直接成功（result `{ verdicts: [], routed: {} }`）。否则用 role 的 harness 判决，要求输出 `{ verdicts: JudgeVerdict[] }`；把判决按 routes 分组 → routed: Record<目标节点, subject[]>，路由到 'human' 的创建 attention；记 `judge.verdict`；判决写到存放区 `reports/verdicts/<runId>-<nodeId>-<iteration>.json`（kind verdict）。路由目标节点：没有分到 subject 的标 skipped。
- **loop**：body 是子 DAG，节点 id 为 `<loopId>/<childId>`（needs 在 body 内解析）。每轮：重置 body 节点为 pending（iteration+1），跑完 body，然后 `until(ctx)`；true → succeeded；达到 maxIterations → onExhausted（human → attention + waiting_human；fail → failed）。
- **planner**：用 role 的 harness 跑 prompt，要求输出 `{ items: PlannedItem[] }`；校验：数量 ≤ maxItems、role ∈ allowedRoles、dependsOn 引用存在且无环，任一不满足 → 节点失败并写明原因（不截断）。展开：每个条目 `expand(item)` 的节点 id 加前缀 `<plannerId>/<item.key>/`，条目内 needs 相对解析；条目 B dependsOn A：B 的入口节点依赖 A 的出口节点。记 `dag.expanded`，写进 state.expansions。planner 自身在所有展开节点完成后才 succeeded；下游节点等它。resume 时用 state.expansions 恢复展开（不重新规划）。
- **subflow**：MVP 抛 "not implemented" 错误即可。

### 产物收集
节点结束后，对 outputs 每项在存放区里按 glob 找文件 → `writeArtifact`（derivedFrom = 节点开始时的 inputs 版本，producedBy = {runId,nodeId}，author = agent/system actor）→ 记 `artifact.written`；必需产物缺失 → 节点失败；.json 产物有 schema 时校验。节点开始时把 inputs 解析到的产物版本写入 NodeState.inputs。

## 测试（vitest，临时目录 + 进程内 mock harness，测试文件里自己写一个最小 HarnessAdapter，不要依赖 @taktflow/harness）

1. 线性 script → agent → gate 跑通，事件链 verify 通过，产物有版本和溯源；
2. human 节点：start 返回 waiting_human → answer → resume 后完成；
3. loop + judge：第一轮 run 返回 1 条失败 → judge 判 product_bug → 只有 fix-code 运行、其他路由目标 skipped → 第二轮无失败 → loop 成功；
4. planner：返回 3 个条目（含依赖）→ 展开 6 个节点、依赖正确；返回超过 maxItems → 节点失败；
5. 写权限守卫：agent 写了 writeScope 外的文件 → guard.violation；
6. 跑 `templates/workflows/sdlc.workflow.ts` 前半段（到 review-spec 的 waiting_human）不报错。

## 完成定义

`npx tsc -b packages/core` 通过；`npx vitest run packages/core` 全部通过（含 core-store 的测试）。
