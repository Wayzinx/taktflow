# 开发简报：M3 后端（外部参考改进，docs/design/19）

**先读**：`AGENTS.md`、`docs/design/19-外部参考与改进.md`、你负责的那一节。
**协议已经加好**（全部是可选字段，旧数据兼容），不要改 `packages/core/src/{types,interfaces,api}.ts`；确需改动写进交付说明的"协议变更请求"。本轮新增的协议要点：

- types.ts：`BaseNodeDef.goal / owner`、`AgentNodeDef.completion / strictOutputs`、`CompletionCheck`、`GateCheck` 的 `acceptance`、`VerdictCategory` 新增 `test_data / deployment / permission / external_dependency`、`ReviewNodeDef.stopAfterNoProgress / arbiter`、`ReviewIssue.title / category / groupKey / fingerprint`、`ReviewRecord.arbiter`、`IssueObservation / ReviewContinuity / ReviewDisposition`、`ReviewRound.revision / seq / targetFingerprint / continuity / stopReason`、`Tier / RunBudget / WorkflowMeta / RouteDecision`、`SnapshotNode.goal / owner / completion`、`NodeState.revision / summary / checks / failures`、`FailureRecord`、`RunState.kind / origin / route / budget`、新事件（`node.checks`、`retry.suppressed`、`budget.warning / exhausted`、`route.decided`、`review.arbitrated / disposition`、`worktree.bootstrapped`、`lesson.recalled / learned / updated`；`artifact.edited.impact`、`human.answered.boundTo`、`review.exhausted.reason`）、`ContextSource 'lesson'`、`QualityMetrics`、`Lesson`、`SpaceMember.duties`、`RepoBinding.bootstrap / share`、`RoomMessage.route`（kind `route`）、`LeadPresence / Room.lead`、`TaskSpec.impact / completion`、`LeadAction` 的 `command` 与 `start_run.budget`、`TaktConfig.route / budget / retry / lessons`。
- interfaces.ts：`AttentionItem.kind / boundTo / stale / owner / assignees`、`AttentionStore.answer(..., { boundTo })`、`LessonStore`、`LessonRecall`、`ProjectStores.lessons`、`EngineDeps.lessons`、`StartRunInput.budget / route / kind / origin`、`RepoManager.createWorktree` 返回 `bootstrap`。
- api.ts：`ReviewFacets`、`ReviewSummary.revision / facets`、`NodeDetail.review.facets / dispositions`、`NodeDetail.goal / summary / completion / completionChecks / failures`、`GraphNode.revision / round / reworks / goal / summary`、`RunDetail.budget / quality`、`BudgetStatus`、`RequirementSummary.current / tier / quality`、`ProjectOverview.totals.verified / intercepted`、`RunSummary.tier`、`ReviewDispositionRequest`、`RoutePreviewRequest`、`CommandInfo / CommandRunRequest / CommandRunResponse`、`LessonUpdateRequest`、`ArtifactEditRequest.impact`、`EditableWorkflow.meta` 的新键与 `setMetaValue` 编辑。
- 共用函数：`packages/core/src/util/budget.ts`（`budgetUsage`、`mergeBudget`、`BUDGET_WARNING_RATIO`）——预算口径只在这里定义。

第一批四个任务并行，**负责范围互不重叠**；第二批 m3-integrate 做接入。各任务只跑自己范围的测试与 `npm run demo`（hello-delivery）；`demo:standard / demo:chat` 在接入任务里统一修。

---

## 任务 m3-engine（引擎纪律）

**负责范围**：`packages/core/src/engine/{runtime,execution,harness,process,guard,scope,schema,index,repository-options}.ts`、`engine/nodes/{gate,loop,judge,planner,host,schemas}.ts`、新建 `engine/{completion,fingerprint,budget,acceptance}.ts` 及测试、`packages/core/src/store/snapshot.ts`。
**不要碰**：`engine/nodes/review*.ts`、`engine/review-options.ts`、`engine/{stale,answers,artifacts,graph}.ts`（m3-review）；`lead/**`、`route/**`、`commands/**`、`insights/**`、`lessons/**`。

1. **完成标准**（`completion.ts`）：agent 节点有 `completion` 时，在 prompt 末尾追加固定格式的"完成标准（逐条自检）"段，并把结果 JSON 的 schema 扩展为必须含 `checks: CompletionCheck[]`（每条一项，id 为 `c1..cn`）。执行后校验：缺项、`pass: false`、`pass: true` 但 `evidence` 为空 → 节点失败，error 为 `完成标准未满足：c2 …`；无论通过与否都发 `node.checks` 并写 `NodeState.checks`。
2. **小结与目标**：结果 JSON 里有字符串 `summary` 时写入 `NodeState.summary`（截断 80 字），否则取最终消息的第一行。没有 resultSchema 也没有 completion 的节点不强制 JSON。
3. **输出契约**：`strictOutputs: true` 时，节点在存放区新建 / 修改的、不在 outputs 声明里的文件，移到 `.takt/quarantine/<runId>/<nodeId>/`（保留相对路径）并发 `guard.violation`（rule `output-contract`，action `reverted`）；非 strict 维持现有 `artifact.untracked`。
4. **失败指纹**（`fingerprint.ts`）：
   - 输入身份 = 节点 inputs 的 `path@version` 排序拼接 + worktree HEAD（有 worktree 时 `git rev-parse HEAD`），取 sha256 前 16 位；
   - 指纹 = sha256(`nodeId:code:target:inputs`) 前 16 位，计入 `NodeState.failures`；
   - 失败码：`completion.unmet`、`gate:<检查 id>`、`judge:<类别>`、`exit:<码>`、`timeout`、`guard`、`error`。
   - 接入点：节点重试循环（`runtime.ts` 的 retry）、loop 迭代（同一指纹第 N 次出现提前结束，走 onExhausted）、判决路由（同一 subject 同一类别、修复节点输入没变）、门禁检查失败。
   - 同一指纹出现次数达到 `config.retry.maxSameFailure`（默认 2）→ 不再重试：发 `retry.suppressed`，节点 `blocked`，建待办（`kind: 'retry'`，form `choice`：`再试一次` / `交给人处理` / `终止运行`）。判决类别 `flaky` 不受指纹限制（仍受 retry.max）。"再试一次"把该指纹计数清零后重跑。
5. **预算**（`budget.ts`，口径用 `util/budget.ts`）：
   - 生效预算 = `mergeBudget(config.budget, workflow.budget, input.budget)`，写 `RunState.budget`；
   - `concurrency` 与引擎 concurrency 取小；
   - 用量 = 本运行 `harness.usage` 累计 token / 成本，分钟 = 距 startedAt；
   - 首次到 80% 发 `budget.warning`；到 100% 发 `budget.exhausted`，停止调度新节点（已在跑的跑完），建待办（`kind: 'budget'`，choice：`追加 50% 预算` / `停止运行`），运行进入 `waiting_human`；追加后把各项预算 ×1.5 写回并继续。
6. **交付校验**（`acceptance.ts`，gate 的 `acceptance` 检查）：用 `insights/trace.ts` 已有的追溯图（只读调用），逐条 AC 检查"有用例、最近一次执行通过、有证据"，`details` 给出逐条结果。给了 `role` 时再请该角色复核（rubric 形式）。该角色若与本运行中产出这些用例 / 代码的 agent 角色相同，直接判不通过并写明原因。
7. **planner 并行安全**：展开后若两个条目的 agent 节点 `writeScope` 有交集（glob 静态前缀互为前缀即视为相交，写在 `fingerprint.ts` 旁边的小函数里或复用 util/glob），按条目顺序给后者加依赖改为串行，并发 `log` 事件说明。
8. **prompt 顺序**（`harness.ts` 的上下文组装）：角色说明 → 技能清单 → 知识 → 经验 → 输入产物 → 节点 prompt → 完成标准 → 打回意见 / 上次失败原因。稳定部分在前；加测试：同一节点两次执行只有 feedback 不同时，prompt 在 feedback 段之前逐字节相同。
9. **经验挂点**：`deps.lessons` 存在时，agent 节点开始前 `recall({ runId, nodeId, role, paths: writeScope + inputs, feedback })`。
   - 非对照组且有文本：注入"经验"段，计入 `ContextSnapshot`（source `lesson`）。
   - 命中 id 非空：发 `lesson.recalled`。
   - 节点第一次执行结束：`record({ outcome: 成功 ? 'helped' : 'hurt' })`，把返回的状态变化逐条发 `lesson.updated`。
   - 测试用假实现。
10. **待办派发与绑定版本**：`host.request` 增加可选参数 `boundTo`；human 节点默认用 `ns.inputs`。创建待办时带上 `owner = node.owner`，`assignees` 为 `config.members` 里 `duties` 含该 owner 的成员 id。
11. **worktree 引导**：`createWorktree` 返回 `bootstrap` 时发 `worktree.bootstrapped`；抛错（引导失败）时节点 `blocked`，error 写原因，不调用 harness。
12. **启动参数**：`StartRunInput.route / kind / origin` 写入 RunState；有 route 时运行开始后发 `route.decided`。
13. **快照**（`store/snapshot.ts`）：
    - 节点：`goal`、`owner`、`completion`；
    - review：`stopAfterNoProgress`、`arbiter`（`{ role, focus, harness }`）；
    - workflow 元数据：`useWhen`、`tiers`、`leadInstructions`、`dynamicRules`、`budget`。
14. **判决类别**：`nodes/schemas.ts` 的枚举加新类别；路由表里没配的类别按 `'human'` 处理。

**测试**：每一条都要有单测（临时目录、mock harness）。
**完成定义**：
- `npx tsc -p packages/core/tsconfig.json --noEmit`；
- `npx vitest run packages/core/src/engine packages/core/src/store`；
- `npm run demo`。

---

## 任务 m3-review（评审 v2、审批绑定版本、措辞 / 语义）

**负责范围**：`packages/core/src/engine/nodes/{review,review-schema,review-target}.ts`、`engine/review-options.ts`、`engine/{stale,answers,artifacts,graph}.ts`、新建 `engine/nodes/review-continuity.ts`、新建 `packages/core/src/review/**`（处置）、`store/{artifact-edits,fs-attention}.ts`、`insights/reviews.ts`、新建 `insights/attention.ts`，以及这些文件的测试。

1. **修订与编号**：
   - 打回重做一次，`NodeState.revision` +1（首次为 1）；修订内轮次从 1 开始，`seq` 全局递增。
   - 文件写 `reviews/<节点>/r<修订>-round-<轮>.json`，`summary.md` 包含所有修订。
   - 读取兼容旧文件 `round-<n>.json`（视为修订 1）。
2. **目标指纹**：产物目标取排序后的 `path@version` 的 sha256；代码目标取该仓库本运行 diff 的 sha256。写入 `ReviewRound.targetFingerprint`。
3. **问题延续**（`review-continuity.ts`）：
   - `groupKey` = 位置（去掉行号、转小写）+ `category ?? severity` + 标题（`title ??` 描述前 40 字，去标点空白）的归一化串；
   - `fingerprint` = sha256(location + severity + description) 前 16 位；
   - 与上一轮比（新修订的第一轮和上一修订的最后一轮比），算出 `new / repeated / changed / not_observed`；
   - 上轮作者回应 `fixed` 但本轮 `repeated` → `regressed: true`；
   - 结果写入 `ReviewRound.continuity`，问题自身也补上 `groupKey / fingerprint`。
4. **早停**：失败轮之后，若最近 `stopAfterNoProgress`（默认 2，0 关闭）轮都是失败轮，且都没有 `new / changed` 的 blocker、major，就提前按 `onExhausted` 处理：`review.exhausted.reason = 'no_progress'`，`round.stopReason`。
5. **裁决**：配置了 `arbiter` 且结论冲突（至少一个 approve，并且至少一个 request_changes / reject 含 blocker）时，开新会话请裁决者看全部记录，输出一条 `arbiter: true` 的记录，由它决定本轮是否通过；发 `review.arbitrated`。
6. **作者不能评自己**（`graph.ts` 的 validateDag）：`reviewers` 或 `arbiter` 的 role 等于 `author.role` → 定义错误"评审者不能是作者角色"。
7. **人工处置**（`review/dispositions.ts`，从 core index 导出 `setReviewDisposition`、`listReviewDispositions`）：
   - 写入存放区 `reviews/<节点>/dispositions.json`（追加，同一 groupKey 以最新为准；走 WorkspaceStore 写产物，reason 必填）；
   - 往该运行的事件日志追加 `review.disposition`（actor 为人）；
   - groupKey 必须在该节点的评审记录里出现过；处置时记下当时的 fingerprint，之后指纹变了处置失效。
8. **正交状态**（`insights/reviews.ts`）：`listReviews` 与 `reviewDetail` 返回 `revision`、`facets`，详情返回全部修订的 rounds 与 dispositions。
   - outcome：最终轮通过且无问题 → `no_findings`；通过但有问题 → `approved`；有 reject → `rejected`；耗尽 / 交人 → `escalated`；其余未通过 → `changes_requested`。
   - coverage：每个评审者都有记录且目标都可读 → `full`。
   - freshness：存放区或代码现在的版本比该轮看到的新 → `stale`；判断不了 → `unknown`。
   - `open` 按人工处置过滤。
   - `observed` 统计最近一轮。
9. **审批绑定版本**：
   - `answers.ts` 回答审批时，`boundTo` 取待办上的 `boundTo`，没有则取节点当前 inputs；写入 `human.answered` 并传给 `attention.answer`；
   - `fs-attention.ts` 持久化 `boundTo`；
   - review 的人工确认（humanSignoff）创建待办时把评审目标的当前版本作为 `boundTo` 传给 `host.request`（该参数由 m3-engine 加，签名：`host.request(entry, ask, form, choices?, signoff?, boundTo?)`；若接口名与此不同，以 m3-engine 的实现为准，在交付说明里写明）。
   - `insights/attention.ts` 导出 `withAttentionStaleness(stores, items)`：boundTo 里任一产物现在有更新版本，就置 `stale: true`。
10. **措辞 / 语义**：`markArtifactEdited(stores, ref, actor, reason, impact?)`；`impact === 'cosmetic'` 时只追加 `artifact.edited`（带 impact），不传播 stale，返回空列表。

**完成定义**：
- `npx tsc -p packages/core/tsconfig.json --noEmit`；
- `npx vitest run packages/core/src/engine packages/core/src/insights packages/core/src/store packages/core/src/review`；
- `npm run demo`。

---

## 任务 m3-route（路由器、命令注册表、Lead 准则、workflow 元数据编辑）

**负责范围**：新建 `packages/core/src/route/**`、`packages/core/src/commands/**`；`packages/core/src/lead/**`；`packages/workflow-source/src/**`；`templates/agents/lead.md`；`packages/core/src/index.ts`（只追加导出行）。

1. **路由器**（`route/`）：`routeRequirement({ stores, requirementId, hint?, workflows: Array<{ id: string; snapshot: WorkflowSnapshot }>, model?: (prompt: string, schema: object) => Promise<unknown>, by: Actor, override?: { tier: Tier; reason: string } }): Promise<RouteDecision>`。
   - 模型输出 `{ tier, surfaces, workflowId?, reason }`。
   - 确定性校验：
     - T3 的改动面两两路径相交（glob 静态前缀互为前缀）→ 降 T2，写进 `adjustments`；
     - 模型给的 workflow 不支持该档（`tiers` 存在且不含）→ 改选；
     - 选择顺序：模型指定且支持 → 第一个 `tiers` 含该档的 → `config.route.defaultWorkflow` → `taktflow-standard` → 第一个。
   - `gates` 为所选流程里 gate / review / human 节点的标题，`roles` 为去重角色。
   - 没有模型时用启发式：hint / 需求标题里出现的顶层目录或仓库数 ≤1 → T1，出现 diff 块或"只改 / 改成"一类明确指令 → T0，多个 → T2。
   - `override` 写入 `overridden`。
2. **命令注册表**（`commands/`）：`createCommandRegistry(deps: CommandDeps)`，导出 `list(): CommandInfo[]`、`run(id, input, { actor, reason }): Promise<CommandRunResponse>`。
   - 校验：输入 schema（用 `engine/schema.ts` 的 validateSchema）、`minRole`（按 `config.members` 找 actor 的空间角色；actor 为 agent / lead 时按 member 处理）、write / dangerous 必须有 reason。
   - 审计：通过注入的 `deps.audit(entry)`。
   - 首批命令：
     - 查询：`requirement.status`、`run.status`、`attention.list`、`lessons.list`；
     - 写：`requirement.create`、`route.preview`、`run.start`（workflowId 可为 `auto`，可带 budget）、`run.resume`、`attention.answer`、`task.dispatch`、`review.dispose`、`lesson.status`；
     - 危险：`run.cancel`。
   - 需要其他模块的 handler 一律通过 `CommandDeps` 注入函数（startRun、resumeRun、cancelRun、answerAttention、dispatchTask、disposeReview、setLessonStatus、route），测试用假实现；接入由 m3-integrate 完成。
3. **Lead**：
   - 动作执行器改为映射到命令注册表（同一套校验）；`command` 动作只允许 risk 为 `read` 的命令。
   - `start_run` 的 `workflowId: 'auto'`：调用路由器，先发一条 kind `route` 的群消息（带 `route`），再带 route 启动。
   - 上下文顺序（`lead/context.ts`）：lead.md 角色说明 → workflow 的 `leadInstructions` → 动作与命令清单 → lead-notes → 状态快照 → 最近消息 → 触发消息。加前缀稳定测试。
   - **状态灯**：Lead 运行时维护 `LeadPresence`（回合中 thinking；回合后有待办 → waiting，有运行中的运行 / 任务 → working，否则 idle），导出 `getPresence(requirementId)` 与构造参数 `onPresence(requirementId, presence)` 回调。
   - 进度播报只发关键事件：阶段完成、运行结束、待办产生、评审耗尽、预算告警 / 耗尽、重试被抑制、路由决定。
   - `TaskSpec.completion` 透传到任务 workflow 的 agent 节点。`TaskSpec.impact`：任务结束后，对任务改写的已有产物，semantic 调 `markArtifactEdited`（让主流程相关节点过期），cosmetic 只记录。`markArtifactEdited` 的 impact 参数由 m3-review 加；在它完成前先按 semantic 调用，并在交付说明里写明。
   - `templates/agents/lead.md` 补准则：
     - 主动推进，能安全默认的不问人；
     - 必须问人时一次只问一个最高优先级问题，格式 `**待确认**：…（推荐：…；影响：…）`；
     - "下一步"用 `**下一步**：…`；
     - 群里只发关键事件；
     - 结束时先给结论；
     - 任何"通过"都要有证据。
4. **workflow-source**：
   - 解析 `useWhen / tiers / leadInstructions / dynamicRules / budget` 为 `EditableWorkflow.meta` 的 EditableValue；
   - 实现 `setMetaValue`（设置或删除根对象属性，最小文本替换）；
   - lint：
     - tiers 取值非法 → error；
     - reviewers / arbiter 含作者角色 → error；
     - rubric 门禁角色与其上游 agent 角色相同 → warning；
     - agent 节点有 completion 但某条少于 6 个字 → warning。

**完成定义**：
- `npx tsc -p packages/core/tsconfig.json --noEmit`；
- `npx tsc -b packages/workflow-source`；
- `npx vitest run packages/core/src/route packages/core/src/commands packages/core/src/lead packages/workflow-source`；
- `npm run demo`。

---

## 任务 m3-lessons（经验库、worktree 引导、质量度量）

**负责范围**：新建 `packages/core/src/lessons/**`；`packages/core/src/insights/**`（除 `reviews.ts`、`attention.ts`）；`packages/sandbox/src/**`。

1. **存储**：`createLessonStore({ dir, audit? })`，每条经验一个 `<id>.md`（frontmatter 存 trigger、status、source、stats、时间；正文为 body；用 `util/frontmatter`）；修改调用 `audit({ type, id, by, reason })`。
2. **召回**：`createLessonRecall({ store, config })`。
   - 匹配：roles、paths（glob 相交）、signatures（正则匹配 feedback）、categories（feedback 里出现类别名）。
   - 排序：active 在前，再按 helped − hurt。
   - 取 `maxRecall`（3）条、`maxTokens`（600，用 `util/tokens`）以内。
   - 对照组：只对 tentative 经验生效，`hash(runId + nodeId) % 100 < holdoutPercent`（15）时这些不注入，`holdout: true`。
   - `record`：
     - 统计：recalled、helped 每次 +1；hurt 也 +1，但对照组不记 hurt；
     - 转正：tentative 的 helped 达到 5 → active；
     - 退役：任何状态 hurt 达到 2 → retired；
     - userStated 的经验直接 active。
3. **学习**：`learnFromRun({ stores, runId, model?, dailyCalls? })`，先做零 token 提炼：
   - 判决（product_bug / script_defect / case_defect / env_issue / test_data / deployment）之后被修好的失败：
     - title `类别：subject`，body = rationale + fixHint；
     - trigger：修复节点的角色与 writeScope、失败信息首行归一化后转义成的签名、类别。
   - 评审里回潮（regressed）或跨 ≥2 轮重复的问题：作者角色 + 问题位置文件。
   - 守卫：内容含"跳过验证 / 跳过测试 / 绕过 / 无需测试 / bypass / skip verification"一类表述，或门禁、待办的内部标识的，直接丢弃。
   - 按签名 + 角色去重。新经验为 tentative，往该运行的事件日志追加 `lesson.learned`。
   - 有 model 且未超 dailyCalls 时可以让模型把正文整理得更短（可选）。
4. **worktree 引导**（`packages/sandbox/src/repos.ts`）：
   - `createWorktree` 后对 `share` 里的目录：主检出（本地 path 或镜像的工作副本）里有、worktree 里没有的，软链进去；
   - 执行 `bootstrap`（worktree 内 shell，超时 10 分钟），返回 `bootstrap` 信息；失败抛错，错误信息带输出末尾 40 行。
   - 另外修复：`syncSkills` 在源技能更新（内容哈希不同）时覆盖目标副本（目标里用户自建的同名技能仍不覆盖：用一个 `.takt-skill` 标记文件区分）。
5. **质量度量**（insights）：
   - `qualityMetrics(events, workspace)` → `QualityMetrics`：
     - verified：gate.result 里通过的检查数 + 通过的评审轮数；
     - intercepted 分来源计数：门禁失败检查；评审未通过轮次里的 blocker、major 问题数（读存放区 `reviews/**/r*-round-*.json` 与旧的 `round-*.json`）；判决 product_bug；`node.checks` 里 unmet 非空的次数；`retry.suppressed`。
   - `RequirementMetrics.quality` 接入 `metrics()`；
   - 导出 `currentNode(run, graph)`（运行中或等人的那个节点）、`budgetStatus(run, events)` → `BudgetStatus`（口径用 `util/budget.ts`）。
   - 这些函数供 server 读模型使用（接入在 m3-integrate）。

**完成定义**：
- `npx tsc -p packages/core/tsconfig.json --noEmit`；
- `npx tsc -b packages/sandbox`；
- `npx vitest run packages/core/src/lessons packages/core/src/insights packages/sandbox`；
- `npm run demo`。

---

## 任务 m3-integrate（第二批：接入、模板、示例）

**负责范围**：`packages/server/src/**`、`packages/cli/src/**`、`templates/**`、`examples/**`、根 `package.json` scripts、`packages/core/src/index.ts`、`vitest.config.*`、`docs/dev/m3-*.md` 末尾的"交付记录"。发现第一批模块的 bug 可以做最小修复，并在交付说明里逐条列出。

1. **server**：
   - 实现 api.ts 新路由：路由预览、命令列表 / 执行、经验列表 / 修改、评审处置；
   - 读模型补字段：
     - `RequirementSummary.current / tier / quality`、`ProjectOverview.totals.verified / intercepted`；
     - `RunSummary.tier`、`RunDetail.budget / quality`；
     - `GraphNode.revision / round / reworks / goal / summary`；
     - `NodeDetail.goal / summary / completion / completionChecks / failures`、`review.facets / dispositions`；
     - `ReviewSummary.revision / facets`；
     - 待办列表经 `withAttentionStaleness`；
   - `Room.lead` 与群聊 SSE 的 `event: lead`；
   - PUT 产物的 `impact`。
   - 命令注册表的 `CommandDeps` 在这里接线；Lead 运行时用同一个注册表。
2. **遗留问题**：
   - GET 修订列表不写文件，首个修订的时间用文件 mtime；
   - 拖动 / 缩放画布不触发 PUT layout（这是 Web 侧问题，只核对后端行为并记录）；
   - 只有临时任务的需求，阶段条不再显示"尚未运行"：stages 取最近一次流水线运行，没有就给空数组并带 `current: undefined`；
   - 成员修改：请求体兼容 `SpaceMember[]` 与 `{ members, reason }`，reason 进空间审计；
   - 根 vitest 配置纳入 `packages/web/src/**/*.test.ts`。
3. **CLI**：
   - `takt route <REQ> [--hint ..] [--tier T1 --reason ..]`；
   - `takt run <workflow|auto> --req <REQ> [--budget-tokens N --budget-minutes N]`；
   - `takt cmd ls`、`takt cmd <id> --input '<json>' [--reason ..]`；
   - `takt lessons ls|show|retire|activate`；
   - `takt review dispose <run> <node> <groupKey> --state resolved|dismissed|open --reason ..`；
   - 运行结束后调用 `learnFromRun`；
   - `config.lessons.enabled !== false` 时创建 LessonStore 与 LessonRecall 并传给引擎（目录 `knowledge/lessons`）。
4. **模板**：
   - 新建 `templates/workflows/quick-fix.workflow.ts`：tiers `['T0','T1']`，useWhen 写清适用场景。节点依次为：
     - 简短 spec（T0 时跳过，`when: ctx.args.tier !== 'T0'`）；
     - 实现（dev，repo，completion）；
     - 代码评审（reviewer ≠ dev，maxRounds 2）；
     - 交付校验（gate：测试命令 + acceptance）。
   - `taktflow-standard.workflow.ts`：
     - 元数据：tiers `['T2','T3']`、useWhen、leadInstructions、dynamicRules；
     - 关键节点：goal、owner（pm / rd / qa）、completion；
     - 准出前加交付校验门禁（acceptance，role `verifier`）；
     - `templates/agents/verifier.md` 新角色。
   - 保持可视化编辑的受限子集（`takt workflow lint` 通过）。
5. **示例与演示**：更新 `examples/*/mock*.json` 适配完成标准与新节点；演示断言补充：
   - `demo:standard`：评审修订编号（打回后为修订 2 第 1 轮）、facets、`node.checks`、交付校验、quality 度量；
   - `demo:chat`：`@lead` 用 `auto` 启动，出现路由卡与 `route.decided`；Lead 的状态变化；
   - 新增 `npm run demo:quick`：T1 需求走 quick-fix，含一次失败指纹抑制（同一失败两次 → retry.suppressed → 待办）。
6. 在 `docs/dev/m3-backend.md` 末尾追加"交付记录"：每个任务的完成情况、遗留问题。

**完成定义**：
- `npm run typecheck`；
- `npx vitest run`；
- `npm run demo`、`npm run demo:standard`、`npm run demo:chat`、`npm run demo:quick`；
- `npm run takt -- serve --spaces examples --port 4872` 后用 curl 验证新路由的返回结构；
- `npm run takt -- workflow lint taktflow-standard --project examples/standard-delivery`（或等价命令）无 error。

---

## m3-integrate 补充（第一批完成后）

- `store/fs-events.ts` 的事件白名单已由调度方改为按 `EventType` 穷举（包括 `node.recipe`），不用再改。
- 现有失败：
  - `packages/cli/src/lead.test.ts` 2 条；
  - `packages/server/src/integration.test.ts` 1 条：fixture 里评审者与作者同角色，现在被 validateDag 拒绝，改 fixture；
  - `packages/server/src/server.test.ts` 1 条。
  - 原因来自第一批的行为变化（Lead 动作走命令注册表、作者不能评自己）。按新行为修测试或接线，不要回退功能。
- `packages/core/src/index.ts` 补导出：`createLessonStore / createLessonRecall / learnFromRun`（`./lessons/index.js`）、`qualityMetrics`（`./insights/quality.js`，第二个参数为 `{ store, requirementId }`）、`currentNode`（`./insights/current-node.js`）、`budgetStatus`（`./insights/budget.js`）。
- 采纳的协议变更（协议已加好）：
  - `NodeDetail.review.revision`；
  - `SnapshotNode.writeScope` 与 `checks[].role`：在 `store/snapshot.ts` 里填；
  - `ProjectOverview.totals.interceptedBy`；
  - `GET /api/me` → `Viewer`：请求头 `x-takt-user`，缺省为空间第一个 owner；answer、dispose 等写操作的 actor 用它；
  - `PATCH /api/space/repos/:repoId` → `SpaceDetail`：reason 进空间审计。
- **评测与归因**：m3-eval 并行开发，产出 `packages/server/src/eval-routes.ts` 的 `registerEvalRoutes`、`packages/cli/src/commands/{eval,defect}.ts` 的 `registerEvalCommands / registerDefectCommands`、`packages/core/src/commands/eval-commands.ts` 的 `evalCommandSpecs`、读模型用的 `recipeOf(events, nodeId)`。由你在 router、CLI 入口和命令注册表里注册，并把 `NodeDetail.recipe` 接上。调度方会在 m3-eval 完成后通知你做这一步；在那之前先完成其余接入。
- 演示补充：`demo:standard` 结束后录入一个缺陷并跑预检 + 归因（mock 剧本）+ 确认，断言生成了回归用例、成绩单出现 escapes。
