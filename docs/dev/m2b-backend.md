# 开发简报：M2 第二批后端（接入与群聊 Lead）

前置：m2-space-review、m2-workflow-source、m2-sandbox-linux、m2-pi 已完成（见各自简报和 `packages/{core,workflow-source,sandbox,harness}`）。设计见 `docs/design/14–18`。

---

## 任务 m2b-integrate（接入：引擎 × 沙箱 / 仓库 / 技能；server 与 CLI × 空间 / workflow 编辑 / 评审 / 群聊）

**负责范围**：`packages/core/src/engine/**`（只做沙箱、仓库、技能接入）、`packages/server/src/**`、`packages/cli/src/**`、`templates/**`、`examples/**`。不改 web、workflow-source、sandbox 包的内部实现（发现 bug 写进 issues）。

### 1. 引擎接入
- `EngineDeps.sandbox` / `repos` / `skillsDir` 生效：agent、review（评审者与作者）节点为每次 harness 调用创建沙箱（provider 按 `config.sandbox` 选择，默认 local），挂载：工作目录（见下）rw、需求存放区 rw、技能与知识只读；运行前 `syncSkills` 到工作目录；调用结束 dispose。
- 节点带 `repo` 时：`RepoManager.createWorktree` 为该节点开 worktree 作为 cwd，记 `worktree.created` 事件、写 `NodeState.worktree`；节点结束后把 `diff` 写成存放区产物 `tasks/<节点安全名>.diff`（kind code-change）。review 节点 `target.code` 读取该运行中对应仓库各节点的 diff（替换 m2-space-review 里的临时实现）。
- 写权限守卫在 worktree 内照常生效。
- 标准流水线模板：研发阶段的 code 节点加 `repo: '<args.repo 默认 app>'`；增加一个集成节点（script，调用 RepoManager 把各任务分支合并到 `takt/<runId>/integration`，冲突时失败并把冲突文件列进结果交给 judge / 人）。

### 2. CLI
- `takt init [--layout space|legacy]`（默认 space）：按 `stores.paths` 复制模板（agents、workflows 含 taktflow-standard 与 sdlc）；`loadProfiles` / workflow 加载全部改用 `stores.paths`。
- 新命令：`space ls`（多空间目录下）、`repo add|ls|sync`、`skill ls|add <dir>`、`member add|ls`、`workflow ls|lint <id>|show <id>|edit <id> --edits <json文件>|revisions <id>|rollback <id> <rev>`、`chat ls <REQ>`、`chat post <REQ> "<text>"`（@lead 时在进程内触发 Lead，见 m2b-lead；本任务先只发消息）。
- `serve --spaces <dir>`：多空间；`--project` 行为不变。修正 `runtime.test.ts` 里写死 harness 数量的断言，改成与 `createHarnesses()` 的结果对比。

### 3. server
- 路由前缀 `/api/s/:spaceId` 与无前缀（默认空间）都可用；`/api/spaces`、`/api/space*`（成员、仓库及同步、技能 / 角色文件读写，写入要 reason，记审计——空间级审计写 `.takt/space-events.jsonl`，复用 EventStore 的哈希链实现）。
- workflow 编辑：用 `@taktflow/workflow-source` 的 store 实现 api.ts 里 workflows 的全部路由与 SSE；作者从请求头 `x-takt-user` 取（缺省 web）。
- 评审：`/api/requirements/:id/reviews`（listReviews）；`NodeDetail.review`（reviewDetail）。
- 群聊：room、members、chat 列表、发消息、SSE；发消息时如果 @lead，调用一个注入的 `onLeadMention(requirementId, message)` 回调（CLI serve 传入，m2b-lead 实现）。
- `/api/runs` 的 `RunSummary.kind / origin` 对临时任务运行生效（m2b-lead 产生）。

### 完成定义
`npm run typecheck`、`npx vitest run`、`npm run demo`、`npm run demo:standard` 通过；新增路由与命令都有测试；`npm run takt -- serve --spaces examples` 能同时看到 hello-delivery 与 standard-delivery 两个空间（`curl /api/spaces`）。

---

## 任务 m2b-lead（需求群聊的 Lead Agent 与临时任务）

**负责范围**：`packages/core/src/lead/**`（新建）、`packages/server/src/**` 与 `packages/cli/src/**` 中与 Lead 接线的部分、`templates/agents/lead.md`、`examples/**`、根 `package.json` 的 `scripts.demo:chat`。

按 `docs/design/15-需求群聊与Lead-Agent.md` 实现：
1. `createLeadRuntime({ stores, engineFactory, harnesses, profiles, ... })`：
   - `onMessage(requirementId, message)`：消息 @lead 或私聊 Lead 时触发一次 Lead 回合；同一需求的回合串行。
   - `onRunEvent(...)`：`config.lead.progressUpdates` 为 true 时，阶段完成、运行结束、产生待办、评审结论、打回时由 Lead 发一条简短的进度消息（模板化即可，不必每次调模型）。
2. 一次 Lead 回合：组装上下文（`templates/agents/lead.md` 角色说明 + 状态快照：阶段、运行中节点、待办、最近判决与评审 + 最近 30 条群消息 + `lead-notes.md`），用 `config.lead.harness`（默认按 lead 角色）调用 harness，`resultSchema` 为 `LeadTurn`；记一次运行级审计（Lead 回合本身也是一次 task 运行，workflowId `lead`，只有一个 agent 节点，便于在运行列表与哈希链里查）。
3. 动作执行器：逐个校验并执行 `LeadAction`（规则见设计文档的表格）。`dispatch_task` → 生成临时 workflow（`task:<role>`：一个 agent 节点，`TaskSpec.review` 不为 false 时追加 review 节点）并启动运行，`RunSummary.kind='task'`、`origin` 指向触发消息；运行中状态变化回帖任务卡片（kind task，refs.taskRunId）。`request_human` → 待办 + 群里 attention 卡片。`propose_workflow_change` → 生成"workflow 修改"待办，人批准后通过 workflow-source store 应用（作者记为 Lead，onBehalfOf 审批人）。`update_notes` → 写 `lead-notes.md`（产物版本）。禁止的动作返回失败结果并在回复里说明。
4. 回复与动作结果作为群消息发出（author 为 Lead；动作结果用 system 消息）。
5. 示例：在 `examples/standard-delivery` 加 Lead 的 mock 剧本；`npm run demo:chat`：创建需求 → 人在群里问"@lead 现在进展如何" → Lead 回复状态 → 人说"@lead 把 PRD 里 AC-2 的描述改成……" → Lead 派发 pm 任务 → 任务运行完成、产物新版本、任务卡片更新 → Lead 回报；校验消息、运行、产物版本、审计链。

### 完成定义
`npm run typecheck`、`npx vitest run`、`npm run demo`、`npm run demo:standard`、`npm run demo:chat` 通过。
