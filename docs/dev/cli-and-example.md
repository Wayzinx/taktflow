# 开发简报：cli + 示例项目

**负责范围**：`packages/cli/src/**`、`examples/hello-delivery/**`、根目录 `package.json` 的 `scripts.demo`。依赖 core（引擎与存储）、harness、knowledge、server，全部已实现，直接复用。

## CLI：`takt`

`takt ws withdraw <path> --reason <原因> [--req <id>]` 记录人工撤回版本并使旧版本的读者失效；省略 `--req` 时只在唯一需求下执行，`ws log` 和指定版本的 `ws get` 保留历史查询。

入口 `packages/cli/src/index.ts`（首行 `#!/usr/bin/env node`）。参数解析用 `node:util` 的 `parseArgs`，不引入框架。全局选项：`--project <dir>`（默认 cwd，向上找 takt.config.json）、`--json`（机器可读输出）。

| 命令 | 行为 |
|---|---|
| `takt init [dir] [--name <n>]` | `initProject`，并把 `templates/agents/*.md` 复制到 `.takt/agents/`、`templates/workflows/sdlc.workflow.ts` 复制到 `.takt/workflows/`（已存在不覆盖） |
| `takt req new "<title>" [--link <url>]` / `takt req ls` | 创建 / 列出需求 |
| `takt ws put <REQ> <path> <file\|-> [--kind input] [--reason <r>]` | 写产物（author = human，id 取 `git config user.name` 或 `$USER`） |
| `takt ws get <REQ> <path> [--version n]` / `ws ls <REQ>` / `ws log <REQ> <path>` | 读产物 / 列产物 / 版本历史（含 author、reason、producedBy） |
| `takt run <workflowId> --req <REQ> [--arg k=v]... [--harness <id>] [--mock <file>] [--auto-approve]` | 加载 workflow、创建引擎、start；运行中订阅事件打印进度（节点开始 / 结束 / 门禁 / 判决 / 守卫违规，一行一条，带阶段和耗时）；结束打印状态和待办 |
| `takt resume <runId> [--auto-approve] [--harness] [--mock]` | 继续运行 |
| `takt answer <requestId> (--approve \| --reject \| --answer "<text>" \| --choice <c>) [--no-resume]` | 回答待办，默认随后 resume |
| `takt status [--req <REQ>]` | 需求列表 + 文本阶段条（例：`需求理解 ✔ → 系分设计 ✔ → 测分设计 ● → …`）+ 最近运行 + 待办 |
| `takt trace <REQ>` | AC 覆盖表 + 追溯边 |
| `takt audit verify <runId>` | 哈希链校验，失败退出码 1 |
| `takt kb query "<text>" [--intent <i>]` | 用 `createDefaultSources` + 路由器检索并打印 |
| `takt serve [--port 4870] [--host 127.0.0.1]` | 启动 server，webDir = `packages/web/dist`（相对 cli 包解析；不存在时提示先 `npm run build -w @taktflow/web`）；`onAnswer` 在进程内 resume 对应运行 |

- **加载 workflow**：`config.workflows` 里的每个文件用 `tsx/esm/api` 的 `tsImport(path, import.meta.url)` 导入，取 default 导出，按 `def.id` 建表；`<workflowId>` 也可以直接是文件路径。
- **harness**：`createHarnesses()`；`--mock <file>` 或项目里存在 `.takt/mock.json` 时用它构造 mock；`--harness` 传给引擎的 `harnessOverride`。
- **knowledge**：`createDefaultSources({ projectDir, taktDir, wikiDir: config 里 kind=wiki 的 options.root })`。
- 输出用简单 ANSI 颜色（无依赖），`--json` 时输出 JSON。

## 示例：`examples/hello-delivery`

一个最小的 Node 项目，用 mock harness 演示完整流水线，**故意让第一轮有一条用例失败**，演示"失败 → 判决 product_bug → 路由给开发修 → 第二轮通过"。

- `package.json`：`{ "type": "module", "scripts": { "test": "node tests/run-cases.mjs" } }`
- `src/greet.js`：`greet(name)` 返回 `Hello, <name>!`；**bug**：name 为空字符串时应返回 `Hello, stranger!`，但现在返回 `Hello, !`。
- `tests/run-cases.mjs`：读 `$TAKT_WORKSPACE/cases/*.json`（字段 `id, title, covers, input, expected`），逐条调用 `greet(input)`，把每条的输入、期望、实际写到 `$TAKT_WORKSPACE/evidence/<id>/result.json`，汇总写 `$TAKT_WORKSPACE/evidence/summary.json`（格式见 `templates/workflows/sdlc.workflow.ts` 顶部注释）。用动态 import 加查询参数避免模块缓存。
- `takt.config.json`：项目名 hello-delivery；workflows 指向 `.takt/workflows/sdlc.workflow.ts`；knowledge 含一个 wiki 源 `docs/wiki`。
- `.takt/agents/`、`.takt/workflows/sdlc.workflow.ts`：从 templates 复制（保持一致，不要改模板）。
- `docs/wiki/greeting.md`：一页"问候语规范"知识（含 frontmatter aliases、verifiedAt）。
- `.takt/mock.json`：MockScript，覆盖 sdlc 模板的每个 agent / judge / planner / rubric 调用：
  - clarify → 写 `spec/clarify.md`；spec → 写 `spec/spec.md`（AC-1 正常问候、AC-2 空名字问候 stranger）；design → `design/design.md` + `design/contracts.json`；design-gate rubric → `{ score: 88, pass: true, message }`；test-design → `test-plan/plan.md` + `cases/TC-GREET-001.json`（covers AC-1）+ `cases/TC-GREET-002.json`（covers AC-2，input ""，expected "Hello, stranger!"）；
  - implement planner → 2 个条目（`greet-core`、`greet-empty`，后者依赖前者，role dev）；code / review 节点写各自的 tasks / reports 文件，带几条 toolCalls；某一个 code 步骤带一次 compaction（演示上下文压缩可视化）；
  - automate → finalText 说明脚本已就绪（脚本是仓库里现成的 tests/run-cases.mjs）；
  - judge（times: 1）→ `{ verdicts: [{ subject: 'TC-GREET-002', category: 'product_bug', confidence: 0.9, rationale, evidence: ['evidence/TC-GREET-002/result.json'], fixScope: 'mechanical', fixHint }] }`；
  - fix-code（times: 1）→ 把修好的 `src/greet.js` 写回（相对 projectDir）；
  - impact → `reports/impact.md`；knowledge-writeback → `reports/knowledge-diff.md`。
  - 每个步骤带合理的 usage，便于度量页有数据。
- `inputs/prd.md`：放在 `examples/hello-delivery/fixtures/prd.md`，由 demo 脚本导入存放区。
- `demo.sh`：清理 `.takt/workspaces .takt/runs .takt/objects .takt/attention.jsonl`，`git checkout` 恢复 `src/greet.js` 的 bug 版本（或从 `fixtures/greet.buggy.js` 复制），然后：`takt req new "问候语支持空名字"` → `takt ws put REQ-001 inputs/prd.md fixtures/prd.md --kind input` → `takt run sdlc --req REQ-001 --harness mock --auto-approve` → `takt audit verify <runId>` → `takt status`。
- 根目录 `package.json` 加 `"demo": "bash examples/hello-delivery/demo.sh"`（脚本里用 `npx tsx packages/cli/src/index.ts --project examples/hello-delivery`）。
- `README.md`：怎么跑、会看到什么、然后 `takt serve` 打开 Web 看。

## 测试

- CLI 参数解析、`run --json` 在示例上的端到端测试（vitest 里复制 example 到临时目录再跑，断言：运行 succeeded、dev-test-loop 迭代 2 轮、`judge.verdict` 事件 1 条、`audit verify` 通过、`reports/quality.md` 存在）。

## 完成定义

`npx tsc -b packages/cli` 通过；`npx vitest run packages/cli` 通过；`npm run demo` 在干净状态下跑完且最终状态 succeeded。
