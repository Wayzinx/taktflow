# 开发简报：运行事件日志压缩

范围是设计 06「压缩与归档」：把历史运行里的噪声事件原样移进归档，主日志变小、seq 与 hash 不变、仍可整链审计。涉及 core 事件存储与新的压缩模块、CLI `runs compact`；不涉及 web 和 server 路由（`GET /api/runs/:id/verify` 原样返回新增的 `reason`）。

## 文件格式

- 归档：`runs/<RUN>/events.archive.<n>.jsonl.gz`，n 从 1 递增（中断留下的未登记归档会被跳过、不覆盖）。内容是被移走的原行，逐字节不变，按 seq 升序。
- 记录：`runs/<RUN>/events.compaction.json`，数组，每次压缩一条 `EventCompactionRecord`：`version: 1`、`at`、`by`（Actor）、`rule`（本次规则列表）、`archive`、`dropped`、`firstSeq` / `lastSeq`（归档里最小 / 最大 seq）、`originalBytes` / `originalSha256`（压缩前主日志）、`archiveBytes` / `archiveSha256`（gzip 后）、`keptBytes`（压缩后主日志）。
- 空间审计：`.takt/space-events.jsonl` 追加一条 log，message 为 `run.events.compacted:<runId>:<archive>:<rules>:<dropped>`，reason 取 `--reason`，缺省「压缩运行 <runId> 的事件日志」。

## CLI

```
takt runs compact <runId> [--rule thinking_tokens|acp-thought-chunks]... [--dry-run] [--reason <r>] [--json]
```

`--rule` 可重复或逗号分隔，缺省只有 `thinking_tokens`。dry-run 只报会归档多少条、预计大小，不写任何文件；正式执行先打印同样的摘要再改写，结束时打印前后大小、归档大小和 verify 结果（verify 失败退出码 1）。运行处于 running 时拒绝。

## 实现要点

- `store/event-compaction.ts`：`compactRunEvents(stores, runId, { rules, dryRun, by, onPlan })`。同一个打开的文件句柄、同一段字节读两遍：第一遍只看行首 seq 和子串、候选行才解析 JSON，记下要归档的 seq；第二遍保留行写临时主日志、归档行写临时 gzip（1MB 批量、背压等待），同时算原文件和归档的 sha256。
- `thinking_tokens` 与读取时跳过共用 `legacyThinkingSeq`。`acp-thought-chunks` 按 `actor.invocationId` 分串：同一调用出现其它事件就结束当前串，凑够 `ACP_THOUGHT_STREAK`（20）条才归档；攒好的整段思考一条一记，不会命中。
- 写完 fsync，再用 `verifyCompacted` 把临时主日志 + 已有归档 + 临时归档整链校验，链尾 seq 必须等于原文件。原链已断时到这一步就失败，原文件不动。
- 换文件在 `withFileLock`（与 append 同一把锁）里：inode 变了或变短就放弃；期间追加的字节用 `continueChain` 确认接得上再原样补到临时主日志末尾；然后 归档 → 记录 → 主日志 依次 rename，目录 fsync 尽力而为，`forgetEventFile` 清本进程缓存。
- `fs-events.ts`：`verifyFile` 读到压缩记录时先比对各归档 sha256，再 `verifyCompacted` 按 seq 归并主日志和各归档流整链校验；同一 seq 两边原样相同只计一次（覆盖「记录已写、主日志没换」的中断），内容不同报断链。缓存的校验前缀带上归档签名（文件名 + sha256 + inode/大小/时间），归档被换、被删或多一次压缩就整链重验。`verify` 返回值新增可选 `reason`。
- `subscribe` 记下订阅时最后一行的 seq，之后只推更大的 seq：文件被压缩换掉时 tail 从头重读也不会重推。
- 读取本来就允许 seq 空洞；检查点、`afterSeq` 游标、append 尾部检查都不依赖连续 seq。
- 压缩后仍超过常驻缓存单文件上限（默认 256MB 的一半，`TAKT_EVENT_CACHE_BYTES` 可调）的日志：第一次整份读时标记 oversize，之后带 `nodeId` 的读取先按子串 `"nodeId":<JSON>` 挑行再解析，其余行只取行首 seq 维持检查点。运行页节点抽屉一次读同一节点四五遍，284MB 的日志每遍从约 1.1s 降到约 0.6s。

## 测试索引

- core/store/event-compaction.test.ts：thinking_tokens 压缩后保留行字节、seq、hash 不变，归档原样，记录字段，读取 / 游标跨空洞 / 冷缓存校验 / 压缩后追加；归档被改动、缺失时 verify 失败并写原因，放回后通过，删掉记录退回连续性要求；运行中拒绝、dry-run 不改文件、没有可归档的行不写文件、未知规则；acp-thought-chunks 只归档 ≥ 20 条的同调用片段串（跨调用穿插不打断、同调用工具调用打断）且需显式指定；最后一行不归档、两次压缩两个归档一起校验；中断状态重复行只计一次、内容不同报断链；原链已断拒绝；订阅不重推。
- cli/cli.test.ts「runs compact」：dry-run、非法规则退出码 2、正式压缩、audit verify、空间审计、再次压缩无可归档、运行中拒绝。

## 实测（580MB 的真实运行副本，Apple Silicon）

| 规则 | 主日志 | 归档 | 耗时 | 峰值 RSS |
|---|---|---|---|---|
| thinking_tokens | 580MB → 298MB（41.8 万条） | 33MB | 13s | ~0.9GB（含压缩后整份 read） |
| 再加 acp-thought-chunks | 298MB → 62MB（45.6 万条） | 26MB | 13s | ~0.46GB |

压缩后整链 verify 约 5s；两条规则都用之后整份读取 0.2s（2.9 万条，进得了常驻缓存）。处理是流式的，内存主要是待归档 seq 的集合和 64KB 读块，不随文件大小整份加载。
