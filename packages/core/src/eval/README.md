# m5-replay 交付说明

## 按编号完成

1. **样本**：`addEvalSample` 从原检查点、成功调用与快照创建样本。`must_catch` 要求有效缺陷、人工确认的五项漏检条件，并在日志追加时检查缺陷 `baseRevision`。`clean` 必须由人明确确认，来源为已完成且无 blocker / major 的评审调用。支持人工退役、版本冲突和幂等添加。旧节点用例仍可读取，不能执行整节点回放。
2. **回放范围**：只允许 reviewer、arbiter、rubric、auditor、evaluator。producer、author、command、acceptance、judge、planner，以及没有检查点的旧整节点用例，都在调用模型前返回 `refused`。
3. **隔离**：候选及评委的全部 fallback 先检查可用性与隔离。允许声明 `readOnly` 的 harness（实际请求传 `readOnly: true`，禁用写工具 / shell），或支持沙箱的 harness 使用 bwrap / docker、临时环境只读挂载、网络 none。验证 provider 返回的实际 spec，拒绝额外、可写或外部挂载；真正调用前再次检查。mock 明确记 simulated，不作为发布依据。
4. **候选与材料**：技能、prompt、角色档案按内容哈希冻结到 `.takt/quality/candidates/<id>/`，只读权限保护，复用前和执行前验证哈希。每次重复与评委都有独立临时目录及存储；快照按清单校验哈希、角色与路径后重映射。技能同步使用临时副本，避免来源标记写入不可变候选包。不把候选文件写回正式空间。
5. **重复与结论**：重复数按请求、空间配置、3 的优先级选择。环境错误、无效输出、评委缺证据均为 insufficient；无缺陷样本提出 blocker / major 记录误报。逐次输出、结论、完整调用身份与 frozenCases 保存在评测日志数据中，并由质量读模型回读。
6. **评委**：两组使用冻结的同一评委角色、技能、模型选择器与 recipeKey；按哈希稳定打乱评判顺序。评委载荷不包含组别、label、模型、候选路径、重复序号或被测调用身份。每次 fallback 与评委调用独立记身份，requested / resolved / reported 分开记录。
7. **报告**：逐样本、逐变体统计 pass / fail / insufficient / falsePositive；Wilson 95% 分母不含 insufficient，0/0 为 n=0、区间 [0,1]。门槛在启动前冻结，报告保留配置；不足样本 / 重复次数、模拟隔离、缺少对照返回 not_applicable。证据不足、回归未全部通过或超出降幅 / 误报增量返回 fail。旧 comparison 先汇总全部重复，探索性或未达门槛时不宣称 better。

## 接入入口

以下函数已由 `@taktflow/core` 包根导出：

- `samples.ts`：`addEvalSample`、`retireEvalSample`。
- `quality-access.ts`：`evalRevision`，供调用方计算样本变更的 `baseRevision`。
- `statistics.ts`：`wilson95`、`blindOrder`、`buildEvalReport`、`validateEvalGate`。
- `runner.ts`：`getEvalInvocations`；现有包入口已经 `export * from './eval/runner.js'`，因此无需额外接线即可导出。

原有入口继续保留：`runEval`、`waitEvalRun`、`getEvalRun`、`listEvalRuns`、`compareEval`、`listEvalCases`、`saveEvalCase`、`collectCases`、`freezeNode`、`defectCases`、`validateEvalCase`、`getEvalOutput`。`readOnlyModel` 保留原调用签名供归因模块使用，但增加前置隔离要求和身份日志。

其余导出是 eval 模块内部协作 / 测试用，不建议暴露为 HTTP 操作。

`addEvalSample(stores, request, by)` 在 must_catch 时要求请求体的 `baseRevision` 为当前缺陷版本；clean 时不需要缺陷版本。`retireEvalSample(stores, id, by, reason, evalRevision(sample))` 必须由人调用。命令 / server 不要通过 `saveEvalCase` 创建 clean 样本，应统一走人工样本入口。

`getEvalOutput` 对 M5 返回每次重复的 JSON 输出与结论；对 M3 保留原文件读取逻辑。`getEvalInvocations` 从质量评测读模型返回被测及评委调用，包括失败 fallback。旧运行没有身份时返回空数组。

## 正式协议接入（m5-integrate）

- `evalView` 通过 `QualityStore.samples()` / `evaluations()` 读取，不依赖 views 的布局。读模型去掉日志内部的 baseRevision，`evalRevision` 对旧对象也会忽略该字段。
- 样本 / 评测写入用 `append.options.baseRevision` 的 objectKind / objectId / revision，在质量提交锁内比较内容哈希。`eval-mutations` 锁保留，用于读改写、重复创建判断与退役串行；不再把它当作跨入口 CAS 保证。
- must_catch 创建另有缺陷版本前提，使用同一正式协议的 defectId / revision 分支，在提交内保证缺陷确认未变；不使用函数第四参数。
- 调用审计采用 `invocation.started` / `invocation.finished`，data 直接放 InvocationStart / InvocationEnd 加 reason、可选 runId；actor.invocationId 与 data.id 必须一致。历史 recovery 扩展记录仍可读。
- `EvalRun.frozenCases` / `judgeCandidate` / `replayEvidence` 与回退结果均使用正式协议类型，移除结构兼容断言。

## 验证

第二批交付时的历史验证（第三批结果见 `.taktdev/out/m5-integrate.md`）：

- `npx tsc -b packages/core packages/harness`：通过。
- `npx vitest run packages/core/src/eval`：5 个文件、59 条测试全部通过，其中 `m5-replay.test.ts` 39 条。覆盖拒绝原因、snapshot / 路径 / symlink、候选冻结、正负样本、重复优先级、Wilson 0/0 和 3/3、误报、盲评顺序、门槛、旧数据导入、并发退役、fallback 身份及 mock 端到端。
- `npm run demo`：通过；运行 `run-20261108-180200-ebef`，完整演示校验通过。
- `npm run demo:standard`：退出码 1。主流程、知识库、评审记录、审计链与真实脚本修复循环校验通过；在 `examples/standard-delivery/demo.ts:123` 的旧断言 `regressions.length === 2` 失败，实际 0。该示例仅确认 M3 的节点级归因，没有人工确认的检查点漏检五条件。按 M5 不应据此生成回放样本。示例属于 m5-integrate 范围，未修改；需改用 M5 漏检确认及样本入口，不应把生成旧写节点样本的行为恢复回来。

标准 demo 证据目录：`/var/folders/v1/n6z6msv922g3jqc1ylnmb2qm0000gn/T/takt-standard-delivery-cmUTS5`，运行 `run-20261108-180315-00ea`。

原 eval 测试中依赖 M3 写节点回放的断言已按新契约调整；没有跳过这些测试。真实模型、真实 bwrap / docker 环境未执行；harness_readonly 和 sandbox 的集成断言使用测试替身，不能作为真实隔离验收。未运行其他执行者目录的测试。

## 未做与文件清单

未修改 server、commands、core 包入口、协议或其他执行者文件；未安装依赖、提交、推送、派发子 agent 或创建 worktree。没有实现写代码节点回放、CLI / HTTP 接线、自动确认或真实环境发布验收。标准 demo 的 M5 接线尚未完成。

本任务新增：`eval/candidates.ts`、`eval/isolation.ts`、`eval/quality-access.ts`、`eval/read-only-call.ts`、`eval/replay.ts`、`eval/samples.ts`、`eval/statistics.ts`、`eval/m5-replay.test.ts`、`eval/README.md`。

本任务修改：`eval/cases.ts`、`eval/model.ts`、`eval/output.ts`、`eval/runner.ts`、`eval/fixture.test.ts`、`eval/m3-fix.test.ts`、`eval/variants.test.ts`。

工作区 `eval/scorecards.ts` 的改动属于 m5-attribution，本任务未改动，也不计入以上交付清单。
