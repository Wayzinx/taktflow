# E：缺陷归因一期接入交付

## 已实现

- `core/quality/observe.ts`：只识别运行冻结快照和动态展开中的文档 review（`target` 为产物路径数组），处理器名 `document-review-observations`，版本 `1`。生成 `found / claimed_fixed / verified_fixed / still_open / declined / overridden`。`verified_fixed` 只由对应评审者对已知 key 的 `previous.status=resolved` 产生；作者 fixed、漏报、not_checked、人工批准均不升级为验证修复。deferred 记 still_open。
- 每次调用的问题各自留观察。同一源事件内只去重同评审者的精确 key；不同轮次仍保存各自的调用事实，共用原 key，不按文本相似度合并，更不会自动创建缺陷。人从多条观察确认一个缺陷时才聚合。loop / 动态节点使用完整节点 ID，跨运行隔离。
- 观察 ID 为 `<source>:<runId>:<seq>:<itemIndex>`；保留源事件、检查点、调用证据以及被评审产物的版本。多个 target 而位置不能唯一对应时不猜文件，检查点继续提供完整材料清单。作者回应关联本轮成功作者调用，未观察到则不借用评审者调用。
- 从源事件重建历史上下文，只向 A 的 `advanceCursor` 提交游标后的数据。观察与游标同批提交；源日志校验失败或质量提交失败则停止，重开后按质量日志游标恢复，缓存丢失或超前不改变事实。
- CLI `run / resume / answer` 在租约释放和 JSON 成功结果输出前同步。`answer --no-resume` 复用引擎现有 `recordAnswerOnce` 先记录人工回答，无需等待下次 resume；Lead 自己的回答审计保持其现有路径。
- `serve` 为每个空间订阅运行事件，发现新运行并补算历史；失败保留待补算任务，后续重试。退出取消订阅、停止发现并等待在途提交。导出 `watchQualityEvents` 供其他常驻宿主复用，调用方必须提供租约钩子与错误处理。
- 新增 `quality sync [--run <id>]`、`quality repair [--reason <说明>]`、`quality verify`、`quality defects [--req <REQ>] [--json]`。verify 失败退出 1；repair 只恢复 A 允许的完整链缺锚点情况，并立即再次校验。质量命令不加载 workflow。
- api-core 实现冻结的全部 10 个质量查询与 7 个写操作名，并增加对应 HTTP 路由。F 的 `attributionCandidates(stores, defectId)` 已直接接通，返回候选及其 revision，不写归因结论。
- 缺陷创建/修改与归因只能由人确认，actor 必须带 via。HTTP actor 使用 `via=web`，CLI 回答使用 `via=cli`，宿主 api-core 必须提供自身 via。更新检查 baseRevision；并发冲突返回 409，detail 带 `QUALITY_REVISION_CONFLICT / key / expected / actual`；空间被占也返回 409。
- 缺陷合并把目标关联观察、源标重复两条事件放入同一批次，分别检查双方 revision；失败不会留下半次合并。拒绝跨需求关联、重复关系成环、缺失观察和非法修改字段。
- 评测样本验证冻结调用、文档评审类型、快照身份和职责资产。clean 需要人确认；must_catch 需要有效缺陷和人确认的 should_have_caught 漏拦调用。候选包复用 A 的内容寻址存储，不改正式空间。
- `eval.start` 登记为可识别操作并返回 501，明确等待 G 的执行器；不创建虚假的 running 报告、不执行 harness。
- 修复本目录 integration 测试对只读快照的清理：只在临时目录清理前恢复目录权限，不改生产快照权限。

## HTTP 与宿主接口

所有路径以 `/api/quality` 开头，保留现有 `/api/s/:spaceId` 多空间前缀。

| 方法与路径 | api-core 操作 |
| --- | --- |
| GET `/defects?id=&requirement=&status=` | `quality.defects` |
| GET `/defects/:id` | `quality.defect` |
| GET `/observations?requirement=&run=&issueKey=` | `quality.observations`（requirement 必填） |
| GET `/invocations/:invocationId` | `quality.invocation` |
| GET `/checkpoints/:checkpointId` | `quality.checkpoint` |
| GET `/defects/:defectId/attribution/candidates` | `quality.attribution.candidates` |
| GET `/evalcases?status=` | `quality.evalcases` |
| GET `/candidates` | `quality.candidates` |
| GET `/evals`、`/evals/:evalId` | `quality.evals`、`quality.eval` |
| POST `/defects` | `defect.create` |
| PATCH `/defects/:id` | `defect.update` |
| POST `/defects/:defectId/attribution` | `attribution.record` |
| POST `/evalcases`、PATCH `/evalcases/:id` | `evalcase.add`、`evalcase.update` |
| POST `/candidates` | `candidate.create` |
| POST `/evals` | `eval.start`（501） |

写请求体约定：

- `defect.create`：`{ requirementId, observations: string[], title, severity, id?, validity?, resolution?, duplicateOf? }`；默认生成 `DEF-<REQ>-<n>`、valid/open，revision=1。不是从模型结果自动确认。
- `defect.update`：`{ baseRevision, reason, patch?, merge?: { id, baseRevision } }`；路由 id 为合并目标，merge.id 为源。patch 对应冻结的 defect.updated.patch（包括增删观察）。宿主也可将 id 放入 body。
- `attribution.record`：`{ baseRevision, attribution }`；路由 defectId，宿主也可放入 body。`attribution.by / at / method` 由入口以当前 actor、时间、human 构造。
- `evalcase.add`：`{ case: EvalCaseView }`，可省 revision，入口固定 1；`evalcase.update`：`{ baseRevision, status, reason }`，宿主可把 id 放入 body。
- `candidate.create`：`{ replaces: [{ asset, content }], params?, exec?, note }`；content 是已经通过 `putObject` 保存的正文对象 SHA256。创建者和时间由入口/存储确定。

查询返回冻结存储实体/实体数组；调用详情返回 `{ invocation, recipe, inputSnapshot }`，合并 finished 的 outcome/reported/replay；检查点详情返回 `CheckpointRef` 并结合调用与 review.result 更新状态。缺失实体 404，非法参数 400。

宿主提供 `withWriteLease` 时整条写操作沿用该生命周期（含 onAnswer）；未提供时，质量写操作自行获取 `api:<pid>` 租约。回答审计与最终补算分别持短租约，允许旧宿主的 onAnswer 回调自行获取执行租约，不把它嵌套在另一 owner 下。

## 文件清单

- core：`quality/observe.ts`、`quality/observe.test.ts`；`index.ts` 仅新增 E 的处理器、文档评审判断和现有 `recordAnswerOnce` 导出，保留 F 同时追加的导出。
- server：新增 `api-quality.ts`、`quality-read.ts`、`quality-validation.ts`、`quality-feed.ts`、`quality.test.ts`、`test-cleanup.ts`；修改 `api-core.ts`、`routes.ts`、`http.ts`、`index.ts`、`integration.test.ts`、`server.test.ts`。
- CLI：新增 `commands/quality.ts`、`quality.test.ts`；修改 `args.ts`、`index.ts`、`commands/run.ts`、`commands/answer.ts`、`commands/serve.ts`。
- 本交付说明：`packages/server/q-e-delivery.md`。

## 验证

- `npm run build`：全部 TypeScript 包和 Web 构建通过。
- `npx vitest run packages/core/src/quality packages/server/src/quality.test.ts packages/cli/src/quality.test.ts`：19/19 通过，包含真实本地 serve 进程启动、跨进程新增事件补算、SIGTERM 清理租约与重启幂等。运行使用 Mock/构造事件，不是实际模型业务验收。
- 接入回归 `npx vitest run packages/server packages/cli/src/quality.test.ts packages/cli/src/lead.test.ts packages/cli/src/api-core-lease.test.ts packages/cli/src/cli.test.ts --maxWorkers=4`：10 文件、109/109 通过。
- `npx vitest run packages/core packages/server packages/cli packages/harness packages/sandbox packages/workflow-source packages/knowledge --maxWorkers=4`：114 文件全部通过；1534 项通过、16 项跳过，共 1550 项，0 失败。限制并发避免共享工作区同时回归造成既有 5 秒用例超时；未修改用例超时或跳过设置。
- `git diff --check`：通过。

首次全范围并发执行为 1529 通过、3 失败、16 跳过。两个 HTTP 回答入口暴露了上述默认租约嵌套问题，现已修复并在 109 项接入回归中通过；另一个 review-node 的 5 秒超时及 ENOTEMPTY 清理错误在单独复跑中通过，未改引擎或提高其超时。

日志位于 `/tmp/takt-q-e-build.log`、`/tmp/takt-q-e-focused.log`、`/tmp/takt-q-e-entry-regression.log`、`/tmp/takt-q-e-final-regression.log`。

## 未做、限制与协议变更请求

- 没有修改 core/store、core/engine、core/insights、web 或冻结协议文件；没有安装依赖、提交、推送、派发子 agent 或创建 worktree。共享工作区中 F 的文件和导出不属于 E 的交付。
- G 的实际回放、评委执行和报告生成未实现，eval.start 按约定返回 501。未运行真实 dsh/模型闭环，没有使用浏览器。
- 处理器每次 sync 重读该运行历史以恢复关联上下文；A 的质量查询仍按其实现重放日志，未引入额外持久索引。历史运行没有 review.result/检查点时不会从当前可变产物猜测观察。
- B 提出的 workflow 源码依赖闭包/插件角色来源采集接线未在本次四项任务中扩展；缺失仍按 B 的 replayNotes 标记 limited，不能宣称可等价回放。
- **协议变更请求**：当前冻结的 `defect.updated.patch.duplicateOf` 只接受 string，A reducer 无删除该字段的路径。改判为 valid/not_a_defect 可以解除重复状态，撤销合并可用 removeObservations，但旧 duplicateOf 指针仍保留。建议调度方增量支持 `duplicateOf: null` 并让 A 删除该字段；E 没有越界修改协议或存储。
- 若宿主自行调用 `syncObservations`，必须持有空间租约；若宿主自行管理 API 写租约，需传 `withWriteLease`，避免入口尝试获取另一个 owner 的租约。
