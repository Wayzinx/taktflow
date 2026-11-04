# 开发简报：harness（执行内核适配器）

**负责范围**：`packages/harness/src/**`。只依赖 `@taktflow/core` 的类型（HarnessAdapter / HarnessRequest / HarnessEvent / HarnessResult）。

**背景**：`docs/design/09-多harness与模型路由.md`。

## 要实现

导出 `createHarnesses(options?): Record<string, HarnessAdapter>`（包含下面全部适配器）和各适配器的工厂函数。

### 公共部分 `process.ts`
- 启动子进程（`spawn`，stdin 默认 `'ignore'`，需要时写入后关闭），逐行读 stdout（NDJSON），超时（req.timeoutMs，默认 30 分钟）和 `req.signal` 取消时先 SIGTERM、5 秒后 SIGKILL；
- 原始 stdout 逐行追加写到 transcript 文件（调用方通过 `req.env.TAKT_TRANSCRIPT` 传路径；没有就不写），结果里返回 transcriptPath；
- `extractJsonBlock(text)`：取最后一个 ```json 代码块并 JSON.parse；req.resultSchema 存在时把它放进 `structured`（校验由引擎做）。
- 错误归类：输出或 stderr 里含 429 / rate limit / 503 / overloaded / 401 / sign in / ACCOUNT_SIGN_IN_REQUIRED / timeout 时，在 `error` 里保留关键词，便于引擎判断是否降级。

### `mock`
`createMockHarness(script: MockScript)`：
```ts
interface MockStep {
  match?: { role?: string; nodeId?: string; promptIncludes?: string }  // 不写 match = 任意调用
  writes?: Record<string, string>   // 相对 req.cwd 写文件（支持 `{{workspace}}/x` 写到 req.env.TAKT_WORKSPACE 下）
  finalText?: string
  structured?: unknown               // 会被序列化成 ```json 块拼到 finalText 末尾
  usage?: Usage
  toolCalls?: Array<{ tool: string; input: string; output?: string }>
  compaction?: { beforeTokens: number; afterTokens: number; summary: string; dropped: string[] }
  fail?: string                      // 返回 ok:false + error
  times?: number                     // 匹配几次后失效，默认无限
}
interface MockScript { steps: MockStep[] }
```
引擎会在 `req.env` 里传 `TAKT_ROLE`、`TAKT_NODE`、`TAKT_WORKSPACE`，mock 用它们做匹配。按顺序找第一个仍有效的匹配步骤；找不到就返回 `ok:true, finalText:'(mock) no step matched'`。另外提供 `loadMockScript(path)` 读 JSON 文件。

### `claude-code`
命令：`claude -p --output-format stream-json --verbose [--model <m>] [--resume <sessionId>] [--append-system-prompt <systemAppend>] --permission-mode bypassPermissions`，prompt 走 stdin。解析：`type: system, subtype: init` → started（session_id）；`assistant` 消息里的 text → message，tool_use → tool_call；`user` 里的 tool_result → 补 tool_call 的 output；`result` → finalText、usage（input_tokens / output_tokens / cache_read_input_tokens、total_cost_usd）、session_id、is_error。available()：`claude --version` 成功。

### `codex`
命令：`codex exec --json --skip-git-repo-check --sandbox danger-full-access -C <cwd> [-m <model>] [-c model_reasoning_effort="<effort>"] -`（prompt 走 stdin）；续聊：`codex exec resume <sessionId> --json ... -`。解析 JSONL：`thread.started`（thread_id → sessionId）、`item.completed` 里 `agent_message` → message / `command_execution`、`file_change` 等 → tool_call、`turn.completed` → usage、`error`/`turn.failed` → error。最终消息为最后一条 agent_message。available()：`codex --version`。
先运行 `codex exec --help` 核对参数，有出入以实际为准并在交付说明里写出来。

### `dsh`（DeepSeek Harness）
可执行文件：环境变量 `DSH_BIN`，否则 `dsh`，否则 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。命令：`<dsh> --profile headless --json [--session-id <id>] -`（prompt 走 stdin）。`--json` 输出 NDJSON 运行事件，格式未文档化：先用 `--help` 查看；解析时识别常见字段（type / message / content / text / usage / session），识别不了的事件当 message 记录，不能崩。最终文本取最后一条助手消息。`ACCOUNT_SIGN_IN_REQUIRED` 时 available() 返回 `{ ok:false, reason:'需要先登录 DeepSeek 账号' }`（available 可以用一个极短任务探测，结果缓存 10 分钟）。

## 测试

- 每个真实适配器用**录制的样例输出**测解析器（把样例 NDJSON 写在测试文件里，解析函数和进程启动分开，便于单测），不要在单测里真的调用 claude / codex / dsh；
- mock：匹配顺序、times、writes 到 workspace、compaction 事件、fail；
- process：超时后能结束子进程（用 `node -e "setTimeout(()=>{},1e6)"`）。

## 完成定义

`npx tsc -b packages/harness` 通过；`npx vitest run packages/harness` 通过。交付说明里写清：每个适配器实际核对过的命令行参数、已知限制。
