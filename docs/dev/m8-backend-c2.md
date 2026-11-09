# 开发简报：M8 后端 C2（事件读取不再整文件重读、自动化调度减负、CLI 角色加载接线、新会话带 runtime）

**先读**：`AGENTS.md`、`docs/dev/m8-backend-c.md`（上一轮）、`.taktdev/out/m8-backend-c.md`（上一轮交付说明，含 CLI 缺口）、`docs/design/30 §2–§4`。

**协议**：本轮只新增 `StewardPostRequest.runtime`（已写好）。不要改 `packages/core/src/{types,interfaces,api}.ts`。

**通用要求**：同上一轮（中文错误信息、不调用付费模型、不发真实网络请求、三个 demo 不变红）。**不要动 `packages/web/`**。本机 4870 端口有正在跑的 serve 和运行，不要停它、不要发请求。

---

## 任务 1：事件读取增量化（`packages/core/src/store/fs-events.ts`）

**问题**：`read(runId, { afterSeq })` 每次都把整个 `events.jsonl` 读进来、逐行 `JSON.parse` 再过滤。质量同步（`quality/store.ts` 每来一条事件就 `read(afterSeq)` 一次）、SSE 补读（`server/src/stream.ts`）、自动化调度都走这条路。真实运行里一个 run 的日志到了 208MB / 30 万行，每次补读都要解析全部，serve 被拖到 CPU 打满。

**要求**：
1. 给每个事件文件维护一份轻量索引（内存里，按文件路径）：已解析到的字节位置、对应的最后 `seq`、文件 `ino`/`size`。
   - `afterSeq` ≥ 索引里的 `seq` 时，只从记下的字节位置往后读（`open` + `read` 指定 position，或 `createReadStream({ start })`），解析新增行并推进索引；
   - `afterSeq` 更小时，可以用稀疏的 seq→字节位置检查点（例如每 1000 行记一个）定位后再读，或退回整文件读取；不要把 30 万个事件对象常驻内存；
   - 文件被替换（`ino` 变了）或变短：清掉索引，按整文件重读；
   - 只读到最后一个完整行（以 `\n` 结尾），半行留给下次。
2. 现有 `appendTails`（追加时的尾部缓存）能复用就复用，不要再维护两套互相打架的状态。
3. 行为与现在完全一致（同样的过滤、同样的损坏行报错文案）。
4. 测试：
   - 追加后增量读取；
   - 半行；
   - 文件被替换 / 截断；
   - `afterSeq` 早于索引；
   - 大文件（例如 5 万行）连续 100 次 `read(afterSeq=最后)` 的耗时上限断言（宽松，例如总计 < 1s），防止回退成整文件读取。

## 任务 2：自动化调度减负（`packages/server/src/automation-runtime.ts`）

**问题**：
- `start()` 对每个历史运行 `events.read(runId)` 整读一遍取最后 `seq`；
- `scan()` 每秒执行一次：`openProject` + 列需求 + 列运行 + 对**每个运行**补读事件，并给**每个历史运行**都挂一个文件订阅。

**要求**：
1. 运行结束事件改为看运行状态，不读事件日志：
   - 记下每个运行上次看到的 `status`，从非终态变成 `succeeded` / `failed` 时派发 `run.finished` / `run.failed`；
   - 启动时已是终态的运行只记状态，不派发（保持"停机期间不补"）；
   - 只给**未结束**的运行挂订阅（用来及时感知），运行结束后取消订阅。也可以完全不订阅、只靠轮询状态，二选一，写清理由。
2. 轮询间隔放宽到 5 秒，`openProject` 结果按空间复用（配置热加载后会换新对象的话，用现有的取最新 stores 的方式，不要每次重新打开）。
3. 新需求检测保持现状逻辑，但同样走 5 秒轮询。
4. 和 `maintenance.ts` 一样随空间加载 / 卸载启停，`close()` 时取消所有订阅。
5. 测试：
   - 状态变化触发一次；
   - 启动时已结束的运行不触发；
   - 结束后订阅被取消；
   - 用 spy 断言调度路径不调用 `events.read`。

## 任务 3：新会话带 runtime（管家）

- `POST /api/steward/threads` 的请求体可带 `runtime`（`StewardPostRequest.runtime`），校验与 `PATCH runtime` 完全一致（同一个函数，不可用 400 带原因）；
- 校验通过后先写进新会话的 `runtime`，**第一条回复就用它**；
- `POST /threads/:id/messages` 带了 `runtime` 时忽略（已有会话用 PATCH），不报错；
- 测试：带可用 runtime 新建、带不可用 runtime 400 且不创建会话、第一轮回复用的是所选 harness（mock harness 断言）。

## 任务 4：CLI 角色加载接线（上一轮交付说明里的缺口）

1. `packages/cli/src/runtime-profiles.ts`：改用上一轮的共用角色加载 / 合并函数（`store/role-sources.ts` 等）。
   - 档案缺 `harness` 时不再拒绝，按"角色 > 空间默认 > 内置"选；
   - 读 `knowledge`；
   - 空间档案与插件同名时空间覆盖插件，不报冲突。
2. `commands/serve.ts`：角色缓存与默认路由不再各自合并，改用同一套函数；角色档案经 `PUT /api/space/agents/:role` 改了之后，下次启动运行能读到新值（不重启 serve）。
3. 多空间 serve 动态新增空间时，同样给它创建命令运行时，让自动化的 `start_workflow` 在新空间里也能用。
4. 测试：
   - 缺 harness 的空间档案、缺 harness 的插件档案都能加载；
   - 同名覆盖；
   - 改档案后新运行读到新值；
   - 动态新增空间的 `start_workflow`。

## 其他

- 上一轮把交付说明写在了 `packages/server/src/m8-backend-c-delivery.md`，已移走；本轮交付说明只写在最终输出里，不要在源码目录放文档。
