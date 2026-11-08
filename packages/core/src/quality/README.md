# 质量日志接入

`openProject` 返回的 `stores.quality` 已挂接 `QualityStore`。未挂接该字段的旧调用者仍走原缺陷文件读写路径。本模块不订阅运行，也不接 CLI / server；由 m5-integrate 在运行结束或收到事件后调用 `sync`。

## 追加数据

`append` 的 `data` 使用协议对象本身，不再包一层 `defect` / `attribution`。除 `observation.recorded`（原因来自源事件）外，数据对象都必须附非空 `reason`，操作者写在信封的 `actor`。

| kind | data |
| --- | --- |
| observation.recorded | `Observation`，`key` 通常与 `id` 相同 |
| defect.created | `Defect & { reason }`，信封必须有 `requirementId` |
| defect.updated | `{ id, ...变更字段, reason }`，信封必须有 `requirementId` |
| attribution.recorded / confirmed | `DefectAttribution & { reason }`，信封必须有 `requirementId` |
| merge.suggested | `DefectMergeSuggestion`，其 `reason` 同时作为审计原因 |
| merge.decided | `{ id, status, decidedBy, at, reason }`，只接受人工决定 |
| sample.added | `EvalCase & { reason }` |
| sample.retired | `{ id, retiredAt?, reason }`，写入样本的 `sample.retiredAt` |
| eval.started / finished | `EvalRun & { reason }` 或 `{ id, ...变更字段, reason }` |
| invocation.started / finished | `InvocationStart` / `InvocationEnd` 加 `{ reason, runId? }`，actor.invocationId 必须等于 data.id |
| recovery | `{ reason, ...恢复信息 }` |

正式读接口 `samples()` / `evaluations()` 从已校验日志重建；投影里的 baseRevision 不属于对象内容。

同一提交先按 key 去重，再检查 `baseRevision`（缺陷序号或样本 / 评测对象内容哈希）；重试已经完成的提交会成功跳过。缺陷 id 在需求内唯一，更新的信封必须包含需求身份。`revision` 由缺陷创建 / 更新日志递增；归因保留独立记录。自动写入会保留在日志中，但不能覆盖人工结论。`QualityConflictError` 由现有 defects 出口间接导出到 core 包入口，可用于映射 HTTP 409。

## 文件与恢复

- 权威日志：`log.jsonl`。哈希规则与事件日志一致；追加后 fsync，再原子替换 `anchor.json`。
- 锚点：`{ seq, hash }`。锚点缺失 / 落后而链完整时可 `repair(actor, reason)`；链损坏、尾部截断或锚点不匹配时拒绝。
- 游标：`cursors.json`，内容为 `{ cursors: { [runId]: seq }, lastSyncAt? }`。追加成功后才推进；重放靠源事件幂等键去重。
- 读模型：`views/{observations,defects,attributions,merges,samples,evaluations}.json`。每次读取从已验证日志重放，可删除后 `rebuild()`。
- M3 导入：首次读模型加载或 `sync()` 导入，`m3:import:complete` 恢复记录表示完整导入结束。缺陷 / 归因键包含需求 id，避免不同需求的 D-1 相互覆盖。
- 提交锁复用 `store/file-lock.ts`。崩溃遗留锁不会按时间强抢；应按锁错误提示确认持有进程退出后人工清理。

`defects/<id>.md` 与归因 JSON 是旧接口写入时生成的投影，不能再作为权威读源。直接 `quality.append` 不更新这些人读文件；后续 API 需要投影时应复用缺陷读写入口。

## 范围限制

事件存储和质量日志现共用 `chain.ts` 的哈希与验链工具。事件日志保留旧的固定业务信封、忽略空行及允许无末尾换行的校验语义；质量日志仍严格要求完整换行与链尾锚点。旧事件日志没有独立锚点文件，本次不改变它的持久化格式。

包根提供 `syncQuality(stores, runId?)`、`verifyQuality(stores)`、`qualityStatus(stores)`、`repairQuality(stores, actor, reason)`；verify 与 status 都返回完整 `QualityStatus`，不自动修复。也可使用包根的 `createQualityStore` / `FsQualityStore`。
