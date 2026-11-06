# F：归因读模型交付说明

## 已实现与接入

公共入口均由 `packages/core/src/index.ts` 增量导出：

- `attributionCandidates(stores, defectId)` 返回缺陷 revision、冻结的根产物版本、产物候选、结构化结果候选及有向边。边从下游指向上游，区分 previous / derivedFrom / input / result。每个触碰事件保留 produced / modified / reused、invocationId、recipeId 和当时的完整 InputSnapshot；reused 不冒充生产调用。没有 invocation 的脚本或人工产物仍保留版本溯源。
- `escapeAnalysis(stores, defectId, injected?)` 返回 `suggested: true` 的检查点建议及五项条件证据。默认只采用人 confirmed 的引入点；显式 injected 允许预览，不改变人工确认状态。没有引入点或发现点时返回 undetermined，不猜测区间。
- `qualitySummary(stores, requirementId?)` 返回缺陷分组、引入阶段 × 发现阶段矩阵、unknown 计数、检查点拦截/漏拦/提出但被放行计数，以及完整 `counting` 口径。
- `recipe(stores, invocationId)` 返回该调用冻结的 Recipe，找不到返回 undefined。`recipeDiff(a, b)` 返回变化字段的 `{ field, before, after }[]`，缺省值使用 null；profile / template / skills 比较完整 AssetRef（kind/id/sha256/revision），skills 顺序遵循冻结配方身份，recipeId 本身的变化也列出。

## 证据与统计边界

- 版本正文按 ref.version 读取并校验 hash，traceIds 从对应正文提取。人工版本继续追溯上一版本；不会把最新记录的 traceIds 或当前工作区正文充作历史证据。版本或对象缺失明确标注；正文 hash 不一致报错。
- 每个产物给出上一登记版本到该版本的统一 diff，最多 16,000 字符，`truncated` 明示截断。首次版本与空文件比较。文本检索支持英文词及中文双字片段，返回段落行号、关键词和分数；最多 8 段，每段最多 2,000 字符，始终标记 `judgment: false`。
- 结构化结果读取 B 已冻结的 `results[].from/object`，保留 run/node/attempt 和正文。该身份没有 invocationId，因此列出该 attempt 在使用结果之前的所有调用，不能指定唯一生产调用；无调用时明确说明。结果正文展示上限 16,000 字符。
- 漏拦区间从引入版本的生产/修改事件（没有时用版本创建时间）到关联观察中最早的 found/still_open，**包含发现检查点**。同运行使用事件 seq 排序，跨运行使用时间；发现后的完成结果不能倒推为此前已执行。
- 材料不含相关产物 → not_exposed；未成功完成 → not_executed；同问题被提出且后来 declined/overridden，且缺陷 valid → caught_but_overridden。问题身份限定在 run/node/attempt/reviewer；跨范围只能使用人显式关联的观察，不按文本合并。
- 有冻结 checklist、没有已关联问题、且没有“仅含引入前版本”的反证时，给 should_have_caught **候选**。五项条件分别列 supported / not_supported / unknown；关键词相似不证明职责对应或其他版本仍有缺陷。缺 checklist 或职责正文只给 undetermined。未实现自动 out_of_scope：没有可机器判定的排除职责协议，不能用关键词不匹配代替判断。
- 读取 rubric 检查点时，成功调用配合对应 gate.result 可证明执行完成；不因没有 review.result 误报未执行。仅有 rubric、没有 checklist 仍为 undetermined。
- 缺陷总数包含全部 validity/resolution；category 仅采用人确认归因，其他归 unknown。阶段与检查点统计只纳入 validity=valid 且 human confirmed 的缺陷。阶段未知作为矩阵独立维值和 unknown 合计保留。
- 检查点按 defectId + checkpointId 去重：成功提出已关联问题且未被拒绝/放行计拦截；人工确认 should_have_caught 计漏拦；人工确认 caught_but_overridden 单列。自动建议和其他状态不进入这三个计数。重复但矛盾的人工逃逸记录不任选一个计数。口径只覆盖已发现且已确认样本，不能估算总体检出率。
- 所有入口不追加运行/质量事件、不推进游标、不调用 E 的写入口；A 的查询方法可正常重建其缓存。返回 revision 供 E 在人工写入时检查。

## 文件清单

- 新增：`insights/attribution.ts`、`escape-analysis.ts`、`quality-data.ts`、`quality-checkpoints.ts`、`quality-summary.ts`、`quality-text.ts`、`recipe.ts`。
- 新增测试：`insights/quality-attribution.test.ts`（26 项，实际临时目录 + FsQualityStore/FsEventStore/版本和对象存储；构造事件，不调用真实模型）。
- `index.ts`：仅追加 F 的 5 行公共入口及类型导出。共享文件中其他 Agent 的增量保留。
- 本交付说明放在负责范围内的 `insights/q-f-delivery.md`。

## 验证

2026-11-06 本地验证（共享工作区同时有 E 的入口改动）：

- `npx tsc -b packages/core`：通过；最终 `npm run build` 再次编译全部 TypeScript 包及 Web，通过。
- `npx vitest run packages/core/src/insights/quality-attribution.test.ts`：26/26 通过，最终跨包回归中此文件同样 26/26 通过。
- `npx vitest run packages/core`：独立运行 48 文件、453/453 通过（这一轮之后补入 1 项 rubric 门禁用例，该项已在最终专项和跨包回归中通过）。
- `npx vitest run packages/core packages/server packages/cli packages/harness packages/sandbox packages/workflow-source packages/knowledge`：最终 114 文件，111 通过、3 失败；1529 项通过、3 项失败、16 项跳过，共 1548。**没有达到全量全绿。**
- 对失败文件复核：`npx vitest run packages/cli/src/cli.test.ts packages/cli/src/lead.test.ts packages/core/src/engine/review-node.test.ts --maxWorkers=1`：40 项中 38 通过、2 失败；review-node 19/19 通过，两个 CLI HTTP 测试仍失败。
- `git diff --check`：通过。只读入口静态检查未发现 append、advanceCursor、writeArtifact 或文件写入调用。

复核后仍失败的范围外测试：

1. `packages/cli/src/cli.test.ts:201`：serve HTTP 回答后恢复 direct workflow，预期 200，实际 500。
2. `packages/cli/src/lead.test.ts:71`：群聊提案经 HTTP 人工审批，预期 200，实际 500。

最终跨包运行还出现 `packages/core/src/engine/review-node.test.ts:92` 的 5 秒超时及随后的 ENOTEMPTY 清理错误；在上述单 worker 复核中通过。未据此改动引擎或调高测试超时。前一轮跨包执行出现过 CLI quality 两例结构化 JSON 解析失败；最终执行这两例已通过，保留前后结果，不将共享工作区的并行变更归为 F 修复。

日志：`/tmp/takt-q-f-build.log`、`/tmp/takt-q-f-core-tests.log`、`/tmp/takt-q-f-regression.log`、`/tmp/takt-q-f-regression-final.log`、`/tmp/takt-q-f-recheck.log`。

## 未做、已知限制与协议

- 未改 core/store、core/engine、core/quality、server、cli、web；未提交、推送、安装依赖、创建 worktree 或派发子 Agent。
- 不自动确认引入点、漏拦或缺陷有效性，不执行回放，不做实际模型/业务验收；写入由 E 的 attribution.record 完成。
- 一期每次查询扫描运行事件，未新增持久化索引；跨运行顺序依赖采集时间。正文检索只提供线索，不能证明因果或语义等价。
- 无冻结协议修改。新增返回类型位于 insights 并增量导出；结构化结果使用 B 的 CapturedInputSnapshot.results 类型，B 已提出的公共协议收口请求仍由调度方处理。
