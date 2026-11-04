# Harness 一致性测试

在 Vitest 测试文件里从 `@taktflow/harness/testing` 导入。发布包使用编译产物；仓库内测试从 `./index.js` 导入源码，无需先构建 dist。

```ts
import { runHarnessConformance, parseHarnessStream } from '@taktflow/harness/testing'
import type { ConformanceFixtures } from '@taktflow/harness/testing'
import { createMyParser } from './my-parser.js'
import { fixtures } from './my-fixtures.js'

runHarnessConformance('my-adapter', {
  parse: parseHarnessStream(createMyParser),
  fixtures: fixtures satisfies ConformanceFixtures,
})
```

最小输入只有 `parse + fixtures`，不要求 runtime、bin 或 harness 工厂。`parse` 接收 `(input, onEvent, request)`，返回 `HarnessResult` 或其 Promise。`ConformanceFixtures<Input>` 可以携带任意输入类型，mock 示例直接传 `MockScript` 给原工厂执行。

`fixtures` 必须包含：

- `success`：最终文本、started/message/tool_call 的具体字段、结果总用量；多轮增量 usage 可用 `expected.usageEvents` 单独声明。结果 sessionId 与 started 的 sessionId 分别断言，避免假定二者必然相等。
- `structured`：输入、schema 和预期对象。检查带 schema 时提取 JSON、不带 schema 时不填 structured；这里验证提取，不宣称完成 JSON Schema 校验。
- `errors`：输入与必须保留的错误关键词。内置覆盖 429/rate_limit、503/overloaded、401/登录、timeout。
- 每条样例的 `name`、`source.kind`（synthetic / recording）和 `source.description`，测试名称直接显示来源。

`parseHarnessStream` 将逐行 parser 接入实际 `finalizeResult`。它不启动 CLI；要验证真实 adapter 的请求处理和收尾，可传 `runtime: { create: bin => createMyHarness({ bin }), replay: fixtures }`。helper 在 `os.tmpdir()` 创建 POSIX 可执行脚本，通过注入路径运行本地子进程，验证事件、结构化结果、错误保真、超时和启动后取消；超时/取消还检查 PID 已回收。未提供 runtime 时不会注册这些测试，也不会声称验证了进程生命周期。测试结束清理临时目录。超时用例先确认真实子进程启动，再推进 Vitest 虚拟计时器触发终止，并检查真实 PID 已回收；这不代表固定毫秒的墙钟耗时测量。

mock 使用 `cancellation: () => createMockHarness(...)` 验证 started 后取消，不模拟 mock CLI。`parse-only.test.ts` 直接运行源码 helper，并检查 package.json 的 `./testing` exports 映射；真实包子路径在集成构建后另行验证。

本目录的样例边界：

- `fixtures.ts` / `new-adapters.test.ts` 的完整事件、schema 和错误样例均为 synthetic。全部 9 个内置加 generic 都注册并执行 conformance。
- `recordings.test.ts` 原样保留三个 root 测试中 2026-11-04 的已有脱敏 `recordedFixture`，分别回放 Claude Code、Codex、DSH。它们是历史录制，未在本次连接模型重录。
- Gemini、Cursor、Qwen、Kimi、OpenCode 没有实录；Cursor/Qwen 只复用 Claude 的合成兼容格式，未使用 Claude 实录为其背书。
