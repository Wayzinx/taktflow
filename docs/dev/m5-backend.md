# 开发简报：M5 后端（归因可信度加固、运行透明与回退；docs/design/21、26）

**先读**：`AGENTS.md`、`docs/design/21-归因可信度加固.md`、`docs/design/26-运行透明与回退.md`，以及你负责的那一节。

**协议已经加好**（全部为可选字段，M3 / M4 的数据照常可读），不要改 `packages/core/src/{types,interfaces,api}.ts`。确需改动，写进交付说明的"协议变更请求"。本轮新增的协议要点：

- **types.ts**
  - 身份：`Actor` 的 agent 变体加 `invocationId`；`ArtifactVersion.producedBy.invocationId`。
  - 检查点与快照：`Checkpoint`、`CheckpointRole`、`SnapshotManifest`；事件 `checkpoint.scheduled / checkpoint.finished / snapshot.created`。
  - 调用：`InvocationStart / InvocationEnd / Invocation`、`ResolvedValue`；事件 `invocation.started / invocation.finished`；`HarnessCapabilities.readOnly / toolPhases / modelOverride / effortOverride`；`HarnessRequest.readOnly`；`HarnessEvent.started` 加 `effort / skills`。
  - 评审：`ReviewNodeDef.references`；`ReviewIssue.key / duty`；`ReviewRecord.checkpointId / invocationId / checklist / previous`；`ReviewResponse.key`；`ReviewIssueEntry`（问题台账）；事件 `review.result / review.issue`。
  - 门禁：`GateCheckResult.status`（pass / fail / error）`/ checkpointId`。
  - 观察与缺陷：`Observation(Source / Kind)`、`MissVerdict`、`MissAssessment`、`DefectMergeSuggestion`；`Defect.observations / validity / resolution / duplicateOf / revision`；`DefectAttribution.checkpoints`。
  - 评测：`EvalCase.sample`；`EvalRun.status` 加 `refused`、`isolation / candidates / repeats / report`；`EvalGate`、`EvalReport`；`TaktConfig.eval`。
  - 质量日志：`QualityLogKind`、`QualityLogEntry`。
  - 运行透明（doc 26）：`harness.tool_call` 加 `phase / callId / durationMs`；`harness.started` 加 `contextWindow / skills`；`node.started.rewindPoint`（`RewindPoint`）；事件 `node.rewound / human.reminded / human.handed_back`；`HumanNodeDef.timebox / assumption`、`HumanTimebox`、`TaktConfig.human`；`human.requested` 加 `assumption / timebox`；`DelegationStatus`、`RoomMessage.receipt`、`RunState.origin.hops / chain`、`TaktConfig.lead.maxHops`。
- **interfaces.ts**：`AttentionItem.kind` 加 `assumption`，加 `timebox / assumption / remindedAt / handedBack / assumedFor`；`QualityStore`、`QualityStatus`、`ProjectStores.quality`。
- **api.ts**：路由表新增"归因可信度""运行透明与回退"两节；`GraphNode.activity`（`NodeActivity`）；`NodeDetail.checkpoints / invocations / issues / changes`、`CheckpointDetail`；`RunTimeline`；`NodeChanges`、`RewindPreview / RewindRequest / RewindResult`；`DefectDetail.observationsDetail`、`DefectUpdateRequest`、`MissDecisionRequest`、`EvalSampleRequest`、`DefectReportRequest.observations`、`EvalRunRequest.repeats`；`StewardDelegation.status` 改用 `DelegationStatus`（旧值 answered / failed 兼容）。

**任务批次**：

- **第一批**（三个并行，负责范围互不重叠；只动 core 与 harness，不接 server / CLI）：m5-capture、m5-runtime、m5-quality。
- **第二批**（两个并行）：m5-attribution、m5-replay。
- **第三批**：m5-integrate（server / CLI 接线、serve 定时、演示、全量验收）。

**通用要求**：

- 只跑自己范围的测试：`npx tsc -b packages/<包>`、`npx vitest run packages/<包>/src/<你的目录>`；第一批、第二批完成前再跑一次 `npm run demo` 和 `npm run demo:standard`（不能变红）。
- 读旧数据不报错：M3 / M4 的运行、评审记录、缺陷文件都没有新字段，读模型按缺省处理。
- 所有路径参数防目录穿越；写操作要 `reason`，进审计。错误信息用中文，并说明下一步怎么做。
- 不确定的值如实记 unknown / none，不拿请求值冒充实际值（这是本期的主题）。

---

## 任务 m5-capture（第一批：引擎采集，doc 21 §1–3 与门禁三态）

**负责范围**：

- `packages/core/src/engine/{harness.ts,recipe.ts,recipe-record.ts,execution.ts,artifacts.ts,acceptance.ts}`；
- `packages/core/src/engine/nodes/{review.ts,review-schema.ts,review-target.ts,review-continuity.ts,gate.ts,judge.ts,planner.ts}`；
- 新建 `packages/core/src/engine/{checkpoints.ts,snapshots.ts,invocations.ts,issues.ts}`；
- `packages/core/src/review/**`；`packages/core/src/insights/{reviews.ts,review-rounds.ts}`；
- 新建 `packages/core/src/insights/node-quality.ts`：`nodeQuality(stores, runId, nodeId) → { checkpoints: CheckpointDetail[]; invocations: Invocation[]; issues?: ReviewIssueEntry[] }`（第三批 server 直接调用）；
- `templates/workflows/taktflow-standard*.ts`、`templates/agents/*.md`（只加职责条目与比较依据）；
- 以上文件的测试。

**不要碰**：`engine/runtime.ts`（m5-runtime）、`packages/harness/**`（m5-runtime）、`core/src/{quality,defects,eval,lead,steward}/**`、server、cli。

1. **检查点**（`engine/checkpoints.ts`）：
   - 按 doc 21 §1 的格式生成 id；评审者、作者修改、裁决者、rubric / acceptance / command 检查项、judge、planner 各一个；调度时发 `checkpoint.scheduled`，结束发 `checkpoint.finished`（done / error / skipped）。
   - 没执行的也要有身份：本轮还没轮到就因前一位出错而中止的评审者记 `skipped`；裁决者只在冲突时调度。
   - `duties`：评审者的 `checklist`；rubric 检查项拆成条目（按行 / 编号拆，拆不开就整段一条）；command / acceptance 检查项用标题。
2. **只读快照**（`engine/snapshots.ts`）：
   - 评审者、裁决者、rubric 调用前，把被评审对象（`target`）和比较依据（`references`）的**指定版本**写进 `.takt/snapshots/<runId>/<safeNodeName(检查点 id)>/files/`，清单写 `manifest.json` 并发 `snapshot.created`。同一修订同一轮的评审者共用内容相同的文件也各自一份清单（快照目录可以硬链接或复制，自己选简单可靠的）。
   - 代码评审：快照里放统一 diff 与改动文件在当时 HEAD 的内容（`source: 'diff' | 'file'`，记 `repo / commit`）；评审者仍可在工作树里读上下文，但 prompt 只指向快照，清单如实记 readOnly。
   - 只读：沙箱 provider 为 bwrap / docker 时把快照目录 `ro` 挂载并记 `sandbox`；否则 chmod 只读并记 `permissions`；都做不到记 `none`。
   - 评审者 prompt 改为列出快照路径与每个文件的角色；不再给存放区当前文件路径。
3. **调用身份**（`engine/invocations.ts` + `harness.ts`）：
   - `callHarness` 对 fallback 链里每个真正启动的候选发一次 `invocation.started`（不可用的候选不记），结束发 `invocation.finished`（含 `durationMs`、用量、harness 回报值）。这次调用期间发出的所有事件，actor 都带 `invocationId`；`collectOutputs` 写产物时 `producedBy.invocationId` 填成功的那次调用。
   - 调用方传入 `{ role: CheckpointRole; checkpointId? }`：普通 agent 节点为 producer，评审者 reviewer，作者修改 author，裁决者 arbiter，rubric 检查 rubric，planner planner，judge judge。
   - 三层取值：`requested` 来自配方选择器、`resolved` 来自 `resolveHarnessSelector`、`reported` 来自 harness 的 `started` 事件；`applied` = `capabilities.modelOverride / effortOverride`（未声明为 undefined，界面显示"未知"）。
   - 技能：declared 为角色档案的技能；`providedHash` = 同步进 harness 技能目录之后该技能目录的内容哈希（复用配方里的技能哈希算法）；`confirmed`：harness 回报了技能清单时按清单记 yes / no，没回报记 unknown。
   - `harness.started` 事件补 `contextWindow`（模型配置）与 `skills`；`harness.tool_call` 透传 `phase / callId / durationMs`，`phase: 'end'` 没给 `durationMs` 时按同 callId 的 start 时间补。
4. **逐评审者落盘**：
   - 每个评审者 / 裁决者完成就发 `review.result` 并写 `reviews/<节点>/r<修订>-round-<轮>/<评审者>.json`（kind review）；本轮汇总文件照旧。
   - 恢复运行时，本轮已有 `review.result` 的评审者不重跑；某个评审者失败只影响它自己（检查点 error），已完成的结果保留；本轮因此 coverage 为 partial，节点按现有失败 / 重试规则处理。
5. **问题键与逐键复查**（`engine/issues.ts`）：
   - 台账保存在评审进度里（随运行状态持久化）；第一次出现的问题由引擎分配 `ISS-<n>`（节点内递增，跨修订有效）。
   - 评审者 prompt 列出台账里未关闭的问题（键、标题、当前状态、上轮作者回应）；`REVIEW_SCHEMA` 增加 `issues[].key`（引用已有键）、`checklist`、`previous`。引用不存在的键按新问题处理并记一条 warn 日志；模型自造的 `ISS-` 格式一律不采信。
   - 状态规则：作者回应 fixed → `claimed_fixed`；评审者 `previous` 给 resolved → `verified_fixed`；still_open → `open`；没给复查结论 → 保持原状态并记 `not_checked`；人工处置 dismissed / resolved 分别记 `dismissed` / `waived`（来自现有 disposition）。每次变化发 `review.issue`。
   - facets 的 `open` 与问题延续改按问题键计算；`groupKey` 保留作跨运行合并建议。
6. **门禁三态**：command 退出码非 0 为 fail，起不来 / 超时为 error；function 抛错为 error；rubric 模型调用失败或输出解析失败为 error；acceptance 读追溯图出错为 error。`pass` 仍 fail-closed（error 时 false），`status` 写三态，并带 `checkpointId`。
7. **标准流水线**（`templates/workflows/taktflow-standard*.ts`）：PRD 评审 `references: ['clarify/**']`；系分评审 `['spec/prd.md']`；测分评审 `['spec/prd.md', 'design/contracts*']`；每个评审者补 3–5 条职责条目（例："每条验收标准都可验证""契约字段与 PRD 一致"）。路径以模板实际产物为准。
8. **node-quality 读模型**：从事件组装 `CheckpointDetail`（状态、快照清单、调用 id、评审记录或门禁结果）、`Invocation`（started 与 finished 合并）、问题台账（按 `review.issue` 重放）；M3 旧运行没有这些事件时返回空数组。

**验收**：

- 单测覆盖：检查点 id 与 skipped；快照清单与只读方式；fallback 两个候选产生两次调用、事件 actor 带 invocationId；三层取值（mock harness 声明 / 不声明 modelOverride）；逐评审者恢复不重跑；问题键分配、引用、自造键拒绝、claimed vs verified；门禁三态。
- `npm run demo:standard` 通过，且运行目录里有 snapshots、事件里有 checkpoint / invocation / review.issue。

---

## 任务 m5-runtime（第一批：运行透明与回退，doc 26）

**负责范围**：

- `packages/harness/src/**`（全部适配器）；
- `packages/core/src/engine/runtime.ts`；新建 `packages/core/src/engine/rewind.ts`；
- 新建 `packages/core/src/insights/{activity.ts,timeline.ts,changes.ts}`；
- 新建 `packages/core/src/attention/timebox.ts`（若 `attention` 目录不存在就新建）；
- `packages/core/src/lead/**`；`packages/core/src/steward/tools.ts` 中转达（ask_lead）与回执相关的部分；
- 以上文件的测试。

**不要碰**：m5-capture 的文件（尤其 `engine/harness.ts`：工具两拍与 contextWindow 的透传由 m5-capture 做，你只负责适配器发出这些字段）、`core/src/{quality,defects,eval}/**`、server、cli。

1. **工具两拍**（harness 适配器）：
   - 能看到工具开始的流（claude-code stream-json 的 tool_use / tool_result，codex `--json` 的 item.started / item.completed，native、pi、stream-cli 里能区分的）先发 `phase: 'start'`（无 output），结束发 `phase: 'end'`，同一 `callId`；结束带 `durationMs`。
   - 只报一拍的适配器保持现状；每个适配器如实声明 `capabilities.toolPhases / readOnly / modelOverride / effortOverride`，测试断言声明与行为一致。
   - `started` 事件能拿到实际模型 / effort / 已加载技能时填上（拿不到就不填）。
   - native harness 支持 `readOnly: true`：不注册写文件与 bash 工具。
2. **运行中细分**（`insights/activity.ts`）：`nodeActivity(events) → NodeActivity | undefined`，规则按 doc 26 §1；只看该节点最近一次 `node.started` 之后的事件。
3. **时间泳道**（`insights/timeline.ts`）：`runTimeline(state, events, snapshot) → RunTimeline`，段落与上下文点按 doc 26 §2；planner 展开与 loop 体内节点带 `parent`；长步骤阈值 15 秒；进行中的段 `end` 缺省。
4. **改动卡与回退**：
   - `runtime.ts` 在 `node.started` 里记 `rewindPoint`：节点有 worktree 时记 `{ repo, path, head }`（worktree 还没建就在建好后的第一次开始时记），以及本节点 outputs 声明的产物在开始前的版本。
   - `insights/changes.ts`：`nodeChanges(stores, runId, nodeId) → NodeChanges`：仓库部分用 RepoManager 的 diff（相对 rewindPoint.head，只算本节点期间），存放区部分用本节点写出的版本 vs rewindPoint 版本；`rewindBlocked` 写明原因。
   - `engine/rewind.ts`：`previewRewind` / `rewind`（doc 26 §5）。token = 运行状态 + rewindPoint + 当前 HEAD / 产物版本的哈希；执行时重新算，不符抛 `RewindConflictError`。仓库只恢复本节点改过的路径；存放区写新版本（内容 = 回退点版本，reason 写"回退到 <节点> 之前：<原因>"）；本节点与下游走现有 stale 传播；发 `node.rewound`。运行状态为 running 且本节点或其下游正在运行时拒绝。
5. **等人限时**（`attention/timebox.ts` + `runtime.ts`）：
   - `runtime.ts` 创建待办时带上生效的 `timebox`（节点 > 空间 `human`）与 `assumption`（human 节点的 `assumption`；Lead 的 request_human 动作如有也带上），`human.requested` 同步带上。
   - `tickAttention(stores, now)`：幂等地检查所有待办——到提醒时限记 `human.reminded`（第 2 次起加 owner）；到交还时限且满足条件（form answer + 有 assumption）时以系统身份作答（`handedBack: true`），记 `human.handed_back`，再创建一条 kind `assumption` 的待办（`assumedFor` 指向原待办，不阻塞运行）。审批与选择只提醒。返回本次做了什么，供 serve 记日志。
   - 交还后恢复运行：复用现有"回答后恢复"的路径；下游 prompt 里带"未获回答，按假设：…"。人之后回答 assumption 待办：答案与假设不同 → 按现有产物修改路径让依赖它的节点过期。
6. **转达回执与跳数**：
   - `lead/**`：派发任务时算 `origin.hops / chain`（触发本回合的消息来自任务运行的 agent / 产出时 +1）；超过 `lead.maxHops`（默认 10）拒绝，群里发系统消息说明链路，任务卡 `receipt.status = 'refused'`。任务卡随状态追加：sent → started → done / refused。
   - `steward/tools.ts`：`StewardDelegation.status` 按 sent → taken（Lead 回合开始处理该消息）→ replied；30 分钟无人接手记 expired；发送过程中抛错记 uncertain（不自动重发）；读旧数据时 answered → replied、failed → uncertain。新增 `resendDelegation(messageId, reason)` 只允许 uncertain / expired。

**验收**：

- 单测：每个适配器的 toolPhases 声明与事件一致（用现有 fixtures）；activity 各状态；timeline 段落与上下文点（含压缩、fallback）；回退预览 / 执行 / token 冲突 / 运行中拒绝（仓库与存放区各一例，仓库用临时 git 仓库）；timebox 提醒 / 交还 / 审批不交还 / 幂等；跳数超限拒绝；回执状态迁移与旧值兼容。
- `npm run demo` 与 `npm run demo:chat` 通过。

---

## 任务 m5-quality（第一批：质量日志、读模型、观察入账，doc 21 §7 与 §4 的观察部分）

**负责范围**：

- 新建 `packages/core/src/quality/**`（日志、读模型、入账、M3 导入、校验修复）；
- `packages/core/src/store/project.ts`（只加 `quality` 的创建与挂接）；
- `packages/core/src/defects/{index.ts,schema.ts}` 中"读写缺陷"的部分：有质量日志时从读模型读，写入走日志；M3 的 `defects/<id>.md` 改为投影（给人看的副本），首次加载幂等导入；
- 以上文件的测试。

**不要碰**：归因逻辑与 `defects/precheck.ts`（m5-attribution）、`core/src/eval/**`、engine、server、cli。

1. **日志**：`.takt/quality/log.jsonl`，复用 `store/fs-events.ts` 的哈希链规则（抽一个共用的链工具，不要复制粘贴）；锚点文件与事件存储同一做法。
2. **提交**：查重（幂等键）→ 检查 baseRevision（缺陷的 `revision`）→ 追加 → 更新锚点，在同一把文件锁里完成（复用 server 已有的锁工具或在 core 里提供一个，跨进程有效）。人工确认或改判过的结论，自动结果不覆盖（读模型里人工结论优先，日志照样记）。
3. **读模型**（`.takt/quality/views/`）：观察、缺陷（带 revision）、归因、合并建议、样本、评测运行；可删可重建（`rebuild`）。
4. **观察入账**（`sync`）：按运行读事件，从 `.takt/quality/cursors.json` 的游标继续，提交成功才推进；幂等键 `<来源>:<runId>:<seq>:<序号>`。映射：
   - `review.issue`：raised → finding；claimed_fixed；verified_fixed；dismissed → declined；waived；
   - `judge.verdict`：每个失败对象一条 failure；路由 ignore → ignored；flaky → flaky；
   - `gate.result`：status fail → gate_fail，error → gate_error（只按 `status` 判断；旧事件没有 status 时按 pass 记 fail）；
   - 人工待办里的显式拒绝不入账（那是流程，不是观察）。
5. **M3 导入**：存放区已有的缺陷与归因、`evals/` 里来源为 defect 的用例，首次 `sync` 时幂等导入（键 `m3:<类型>:<id>`）；`status.importedM3` 置 true。
6. **校验与修复**：`status()` 给出链完整性、锚点、游标；`repair` 只在"链完整、锚点落后"时补锚点并记 `recovery`；链被篡改 / 截断抛错。

**验收**：

- 单测：幂等（重复 sync 不重复）、游标崩溃恢复（在追加后、推进游标前抛错，重跑结果一致）、baseRevision 冲突、人工结论不被覆盖、M3 导入幂等、篡改检测、锚点修复、重建一致。
- 并发：两个进程同时追加（`child_process.fork` 或 worker）不丢不重。

---

## 任务 m5-attribution（第二批：缺陷两层与漏检五条件，doc 21 §4）

**负责范围**：`packages/core/src/defects/**`（除 m5-quality 已改的读写外）、`packages/core/src/eval/scorecards.ts`（检出率改用 MissAssessment）、`templates/agents/auditor.md`、以上文件的测试。命令（`core/src/commands/eval-commands.ts`）与路由留给 m5-integrate，你只导出函数。

1. 缺陷从观察创建（可多选），或直接录入外部问题（同时生成一条 report 观察）；有效性与处理状态分开；`DefectUpdateRequest` 带 baseRevision。
2. 合并只给建议：同一检查点 / 同一问题键 / 标题相近的缺陷给 `DefectMergeSuggestion`，人 accept / reject / undo，全部进日志。
3. 漏检判定：
   - 预检（确定性）对每个相关检查点算 ② 材料在快照清单里、④ 执行完成，以及 material_missing / not_executed；
   - ① 引入点早于检查点且快照版本包含缺陷内容、③ 属于职责条目、⑤ 输出没提出：由归因 Agent 给建议（prompt 附快照清单、职责条目、该检查点的输出），人确认；
   - 证明不了的记 undetermined，不用 out_of_scope 吸收未知。
   - 人改判（`MissDecisionRequest`）进日志，自动结果不覆盖。
4. 成绩单检出率：拦下 = 有 finding 且后来被确认有效的检查点；漏掉 = 确认 should_have_caught 的检查点。

**验收**：单测覆盖五条件的每种结论、人工改判优先、合并建议的撤销；M3 归因数据照常展示。

---

## 任务 m5-replay（第二批：回放隔离、候选包、重复与统计，doc 21 §5–6）

**负责范围**：`packages/core/src/eval/**`（除 scorecards.ts）、以上文件的测试。命令与路由留给 m5-integrate，你只导出函数。

1. 样本：从确认的漏检生成 must_catch（期望提出某问题），从人确认无问题的评审调用生成 clean；样本绑定检查点与快照。
2. 只回放只读检查点（评审者、裁决者、rubric、auditor、evaluator）；写代码节点的回放请求直接拒绝并说明。
3. 隔离前置校验，任一不满足 → `status: 'refused'` 与原因：沙箱 bwrap / docker + 快照只读挂载 + 网络关闭；或 harness 声明 readOnly 并以 `readOnly: true` 调用；mock harness 记 `simulated`。
4. 候选包：变体的技能目录 / prompt 文件 / 角色档案在开始时复制到 `.takt/quality/candidates/<内容哈希>/`，报告绑定候选包 id；永不写回空间。每个样本独立临时目录与存储，材料来自原快照按清单重映射。
5. 每个样本每个变体重复 N 次（请求 > 配置 > 3）；结论 pass / fail / insufficient（环境错误、无法回放、评委判不了都是 insufficient）；clean 样本提出 blocker / major 记误报。
6. 评委：两组同一评委配方；隐藏组别、按哈希打乱展示顺序；评委调用记调用身份。
7. 报告：Wilson 95% 区间（分母不含 insufficient）、误报、证据不足、探索性标记、门槛结论（报告存门槛快照）。

**验收**：单测：拒绝启动的每种原因、候选包按内容寻址且不写回、重复与区间计算（含 0/0、3/3）、误报、盲评顺序稳定、门槛结论；mock harness 端到端一例。

---

## 任务 m5-integrate（第三批：接线、演示、全量验收）

**负责范围**：`packages/server/src/**`、`packages/cli/src/**`、`packages/core/src/commands/**`、`examples/**`、`evals/**`（如需）、以上文件的测试。

1. **server**：
   - 新建 `quality-routes.ts`：观察、缺陷更新、合并建议、检查点改判、质量状态 / 同步 / 修复、快照清单与文件（防穿越）；
   - 新建 `run-insight-routes.ts`：timeline、changes、diff、rewind preview / 执行（409 映射）；
   - `read-model.ts`：`nodeDetail` 加 `checkpoints / invocations / issues / changes`；运行图的运行中节点加 `activity`；
   - `eval-routes.ts`：样本、重复、报告；
   - 管家转达重发路由；
   - serve：订阅事件实时 `quality.sync`；每分钟 `tickAttention`（多空间各自串行）。
2. **CLI 与命令**：`takt quality sync | verify | repair --reason`、`takt attention tick`、`takt eval run --repeats`、`takt defect` 的观察 / 合并 / 改判子命令；`core/src/commands/eval-commands.ts` 补对应命令；`takt run` 结束时同步入账。
3. **演示**：`demo:standard` 增加断言：检查点与快照存在、问题键 claimed → verified 的完整路径、质量日志可校验；新增一个回退的小演示（可并进 demo:quick）。
4. **全量验收**：`npm run typecheck`、`npx vitest run`、全部 demo、`npm run build`。

**交付说明**写清：做了什么、没做什么、已知问题、协议变更请求（如有）。
