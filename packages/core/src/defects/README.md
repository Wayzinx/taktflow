# M5 缺陷与检查点归因接入

以下入口已从 `@taktflow/core` 导出并接入 server / CLI；旧 `defects/index.ts` 入口保留 M3 兼容。带版本与原因的 `startDefectAttribution` 后台调用检查点归因，`waitDefectAttribution` 仍可等待并回读。

- `createQualityDefect(stores, requirementId, request, by)`：人工从观察创建缺陷；未选择观察时，同一次日志提交创建 external/report 观察与缺陷。`request.reason` 必填。创建没有已有版本；唯一 id 由文件锁和日志提交锁保护。
- `readQualityDefect(stores, requirementId, defectId)`：读质量日志投影，展开 `observationsDetail`，M3 归因原样保留。
- `updateQualityDefect(stores, requirementId, defectId, request, by)`：`DefectUpdateRequest`，有效性与处理状态独立。人工身份、reason、baseRevision 必填。
- `suggestDefectMerges(stores, requirementId, by, reason)`：基于检查点、作用域内的问题键、标题相似度给建议；不会按用例合并，不修改缺陷有效性。幂等键固定，重算不覆盖人工决定。
- `decideDefectMerge(stores, requirementId, suggestionId, { action, baseRevision, reason }, by)`：action 为 accept / reject / undo。baseRevision 是建议 `defects[0]` 的当前版本。只记录可撤销的人工分组，不删除缺陷或观察。决定与该缺陷的版本推进在同一日志批次，防止并发决定互相覆盖。accepted / rejected 可 undo，undone 可重新 accept / reject。
- `precheckDefectCheckpoints(stores, defect, materials?)`：返回检查点清单、职责、输出、确定性条件与同问题放行证据。材料缺省从关联观察的 artifacts 取得；归因明确引入产物后会再次纳入该产物。缺少材料身份或快照时保持未知；没有执行的检查点仍返回。保守枚举需求的检查点，不从当前文件猜历史读取。
- `attributeDefectCheckpoints(deps, requirementId, defectId, { baseRevision, reason })`：独立 auditor 会话，提供校验哈希后的冻结内容、清单、职责和输出；只写候选。②④始终采用预检；①③⑤有证据才采纳。无明确引入点不能自动断言①，没有输出不能自动断言⑤。人工已确认的单点由质量读模型保护。
- `decideCheckpointMiss(stores, requirementId, defectId, checkpointId, request, by, { baseRevision, reason })`：`request` 使用既有 `MissDecisionRequest`；额外 options 补并发版本与审计原因。人工改判也不能改写②④或将已关联 finding 判为漏检。确认某点不等于确认整个引入归因；其他点仍可自动分析。

所有新写入只通过 quality.append；每次修改已有缺陷都检查 baseRevision，并在同批推进缺陷 revision。无 quality 时明确拒绝，不退回旧文件写入。直接追加不刷新 `defects/*.md` 人读副本，以质量读模型为准。

成绩单以检查点去重：拦下是关联到 validity=valid 缺陷的 finding；漏掉是 validity=valid 且逐点人工 confirmed、五条件为 true 的 should_have_caught。M3 missedBy 原样展示但不伪装五条件；原始评审问题与 gate error/fail 不直接计检出。配方 / 技能按 invocation.recipeKey 归属，缺少调用身份不猜测。

当前协议没有合并关系对多个缺陷版本的批量比较，也没有 MissDecisionRequest 的 reason/baseRevision；本模块用主缺陷版本推进和独立 options 适配，无需修改协议。把 validity 从 duplicate 改回其他值时，历史 duplicateOf 留在日志读模型中，调用者只在 validity=duplicate 时解释该字段。
