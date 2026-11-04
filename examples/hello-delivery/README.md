# hello-delivery

taktflow 的最小示例：需求 → spec → 系分 → 测分 → 对齐 → 研发测试 Loop → 影响面 → 质量报告。

**故意让第一轮有一条用例失败**，用来演示"失败 → 判决 `product_bug` → 路由给开发修 → 第二轮通过"。

## 它是什么

- `src/greet.js`：`greet(name)` 返回 `Hello, <name>!`。**缺陷**：空字符串应返回 `Hello, stranger!`，现在返回 `Hello, !`。
- `tests/run-cases.mjs`：用例执行器。读 `$TAKT_WORKSPACE/cases/*.json`，逐条**真实调用** `greet`，把输入、期望、实际写到 `evidence/<id>/result.json`，汇总写 `evidence/summary.json`；有失败时退出码非 0。
- `fixtures/`：`prd.md`（演示物料）、`greet.buggy.js`（缺陷版本）、`greet.fixed.js`（修复版本）。
- `.takt/agents/`、`.takt/workflows/sdlc.workflow.ts`：从仓库 `templates/` 逐字节复制，不要改这里，改模板。
- `.takt/mock.json`：MockScript，覆盖 sdlc 的每个 agent / judge / planner / rubric 调用；`fix-code` 把修复后的 `src/greet.js` 写回。
- `docs/wiki/greeting.md`：问候语规范知识页（`business` intent，供系分和影响面检索）。

## 怎么跑

在仓库根目录：

```bash
npm run demo
```

等价于 `bash examples/hello-delivery/demo.sh`。脚本会：

1. 清理 `.takt/workspaces`、`.takt/runs`、`.takt/objects`、`.takt/attention.jsonl`；
2. 从 `fixtures/greet.buggy.js` 恢复 `src/greet.js` 的缺陷版本（可重复运行）；
3. `takt req new "问候语支持空名字"`；
4. `takt ws put REQ-001 inputs/prd.md fixtures/prd.md --kind input`；
5. `takt run sdlc --req REQ-001 --harness mock --auto-approve`；
6. `takt audit verify <runId>`，并校验运行 succeeded、Loop 迭代 2 轮、判决 1 条且路由到 `fix-code`；
7. `takt status`。

脚本退出时会把 `src/greet.js` 恢复成缺陷版本，但 `.takt/` 里的运行证据保留。

如果把示例复制到仓库外的独立项目，项目中必须有可解析的 `@taktflow/core` 依赖，因为 `.takt/workflows/sdlc.workflow.ts` 会导入它；仅复制示例文件不足以加载 workflow。

## 已知问题

当前 core 会产生 **2 条原始 `judge.verdict` 事件**：第一轮包含 `product_bug` 判决，第二轮无失败时仍产生一条空 `verdicts` 事件。因此，即使运行状态为 `succeeded`、Loop 的 `iteration=2`、审计链有效，`npm run demo` 仍会显示 `FAIL judge.verdict 事件 1 条 (count=2)`，最终以退出码 **1** 结束。

示例保留“整个运行恰好 1 条原始事件”的严格验收断言，不过滤空事件、不放宽计数。校验失败后仍会打印 `takt status`，便于区分运行状态与演示验收结果；此问题需要在 core 中解决。

## 会看到什么

- 第一轮 `run-cases` 执行 `npm test`：`TC-GREET-001` 通过，`TC-GREET-002` 失败（`Hello, !` ≠ `Hello, stranger!`）；
- `judge` 判 `product_bug`（confidence 0.9，证据指向 `evidence/TC-GREET-002/result.json`），路由到 `fix-code`；
- `fix-code` 写回修复后的 `src/greet.js`；
- 第二轮 `run-cases` 全部通过，Loop 以 `iteration=2` 收敛；
- `reports/quality.md` 的 AC 覆盖表：AC-1、AC-2 各 1 条用例且全部通过；
- `audit verify` 哈希链校验通过。

想单独执行用例（需要先有一次运行的存放区）：

```bash
cd examples/hello-delivery
TAKT_WORKSPACE=.takt/workspaces/REQ-001 node tests/run-cases.mjs
```

注意：demo 退出时已恢复缺陷源码，因此此命令会重新得到 `TC-GREET-002` 失败，并覆盖存放区中的最新用例证据。若要单独验证修复版本，先执行 `cp fixtures/greet.fixed.js src/greet.js`，验证后用 `cp fixtures/greet.buggy.js src/greet.js` 恢复示例。

## 看 Web 控制台

在仓库根目录执行：

```bash
npx tsx packages/cli/src/index.ts --project examples/hello-delivery serve
```

浏览器打开 <http://127.0.0.1:4870>，可以看到需求、阶段条、DAG、每个节点的上下文账本、压缩记录、判决和产物版本。
