# 开发简报：M8 后端 C7（harness × LLM API 自由搭配：内置协议桥、TRAE / Pi 接入、预设补全、搭配矩阵）

**先读**：
- `AGENTS.md`
- `docs/design/31-Harness与LLM自由搭配和严格结构化输出.md`，第 1–4 节、第 6 节
- `packages/core/src/engine/selection.ts`
- `packages/core/src/engine/harness.ts`（`callHarness`）
- `packages/harness/src/{codex.ts,claude-code.ts,claude-env.ts,index.ts,parse.ts,process.ts}`
- `packages/harness/src/adapters/pi.ts`
- `packages/harness/src/providers/`
- `packages/harness/src/acp/presets.ts`
- `packages/server/src/{routes.ts,runtime-test.ts}` 和 serve 里组装 harness 目录的代码

**协议**已写好，不要再改 `packages/core/src/{types,interfaces,api}.ts`：
- types.ts：`PairingMode`、`Pairing`、`ProviderBridge`、`BridgeRoute`；`InvocationStart.provider` / `.pairing`；`EventPayloads['output.invalid' | 'output.repaired']`（这两个事件本轮不用，下一轮用）；`TaktConfig.output`
- interfaces.ts：`EngineDeps.bridge`
- api.ts：`PairingInfo`、路由 `GET /api/pairings`、`RuntimeTestRequest.target` 的 `{ kind: 'pairing' }`

**通用要求**：
- 中文错误信息。
- 不调用付费模型，不发真实网络请求。上游一律用本地 `node:http` 假服务。
- 三个 demo 不变红。
- **不要动 `packages/web/`**。
- 本机 4870、4888 端口有 serve，不要停、不要发请求，也不要碰 `~/taktflow-playground`。

**真实请求样本**：`.taktdev/captures/`（不进 git）里有 Claude Code 2.x、codex-cli 0.159.2、TRAE CLI 0.213.1 对本地假服务发出的真实请求体，各含一轮工具调用往返；`server.mjs` 是抓取用的假服务。
- 测试夹具照它们的**结构**写进测试目录。
- 长文本（系统提示、工具描述）截成占位，`metadata.user_id` 之类的设备标识换成假值。不要整份复制。

---

## 背景（实测）

- **Codex / TRAE 的 Chat 协议已失效**：本机 codex-cli 0.159.2 和 TRAE CLI 0.213.1 都拒绝 `wire_api = "chat"`，报错 "`wire_api = "chat"` is no longer supported"。所以现在 Codex 声明的 `openai-chat` 是坏的，Codex + DeepSeek 跑不起来。
- **TRAE 输出与 Codex 一致**：TRAE CLI（`traecli` / `traex`）是 Codex 分支。`exec --json` 的事件格式与 Codex 一致，`createCodexParser` 能直接解析（已实测）。启动时会多一条 `item.completed` 的 `type: "error"` 配置提示，现有解析已当作消息处理。
- **Pi 的接入方式**（`@mariozechner/pi-coding-agent` 0.73.1，本机未安装）：
  - 扩展里调用 `pi.registerProvider(name, { baseUrl, api, apiKey, headers, models: [{ id, contextWindow?, maxTokens? }] })`，`api` 取 `openai-completions | openai-responses | anthropic-messages | google-generative-ai`。
  - `apiKey` 写环境变量名就会按环境变量解析。
  - 命令行 `-e <扩展文件>` 加载扩展，`--provider <name> --model <id>` 选模型。
- **请求样本里要处理的形态**：
  - Codex 的 `tools` 里有 `type: "namespace"`，内嵌一组 function，MCP 工具就是这样；还有 `type: "web_search"`。
  - TRAE 有 `type: "custom"` 的 freeform 工具，用 lark grammar。
  - Claude Code 的 `messages` 中间会出现 `role: "system"` 的消息，还带 `thinking: {type:"adaptive"}`、`output_config`、`context_management`、`?beta=true` 查询串。
  - Codex 的 `input` 里有 `developer` 角色。

## 任务 1：协议桥 `packages/harness/src/bridge/`

实现 `ProviderBridge`，导出 `createProviderBridge(options?: { resolveSecret?: (name) => string | undefined; fetch?: typeof fetch; keepAliveMs?: number })`。

### 监听、路由、密钥

- **监听**：`node:http`，只监听 `127.0.0.1:0`。第一次 `open` 时才启动；`close()` 关掉所有路由和监听。
- **路由**：
  - 每次 `open` 生成随机 `routeId` 和 32 字节令牌。
  - 返回的 `provider` 字段如下：
    - `protocol = accept`；
    - anthropic-messages 时 `baseURL = http://127.0.0.1:<port>/r/<routeId>`，openai-responses 时为 `…/r/<routeId>/v1`；
    - `apiKeyEnv = 'TAKT_BRIDGE_TOKEN'`；
    - `id` 沿用原 provider。
  - 返回的 `env` 至少包含：
    - `TAKT_BRIDGE_TOKEN`；
    - `NO_PROXY` / `no_proxy`：在已有值后面追加 `127.0.0.1,localhost`。本机常开代理，不加的话 harness 会把本机请求发给代理。
  - 令牌校验接受 `Authorization: Bearer` 和 `x-api-key` 两种。不对返回 401。路由关闭后返回 404。
- **上游密钥**：按 target 的 `apiKeyEnv` 用 `resolveSecret` 读，默认读环境变量再读本机密钥库，与现有 provider 客户端同一套。
  - 读不到就返回对应协议的 401 错误，提示「缺少密钥 X」。
  - 密钥与令牌都不得出现在日志、错误和事件里。

### 两个入口（harness 侧）

**Anthropic Messages**：`POST /r/<id>/v1/messages`，忽略查询串；`POST /r/<id>/v1/messages/count_tokens` 在本地估算，返回 `{ input_tokens }`。

- 请求映射：
  - `system`（字符串或块数组）和 `messages` 中间的 `role: "system"` 消息并入系统消息。
  - content 块：
    - `text`；
    - `image`（base64 / url，转成 Chat 的 `image_url`）；
    - `tool_use`、`tool_result`（`is_error`、内容为字符串或块）；
    - `thinking`（带回来的思考，见下面「思考内容」）；
    - `redacted_thinking` 丢弃。
  - `tools[]`：`{ name, description, input_schema }` 转成函数工具；带 `type` 的服务端工具（`web_search_*` 等）丢弃并记日志。
  - `tool_choice`：`auto`、`any`、`tool`、`none` 分别映射到 Chat 的 `auto`、`required`、指定函数、`none`。
  - `max_tokens`、`temperature`、`top_p`、`stop_sequences` 照传。
  - `thinking`、`output_config`、`context_management`、`metadata` 忽略。
- 流式响应：
  - 事件序列：`message_start`、按块的 `content_block_start/delta/stop`、`message_delta`、`message_stop`。
    - 正文用 `text_delta`；
    - 思考用 `thinking_delta` + `signature_delta`；
    - 工具用 `tool_use` 块 + `input_json_delta`。
  - `message_delta` 带 `stop_reason`（`end_turn`、`tool_use`、`max_tokens`）和 usage。
  - 等上游时每 `keepAliveMs`（默认 15s）发一次 `event: ping`。
  - `stream: false` 时返回完整 message JSON。

**OpenAI Responses**：`POST /r/<id>/v1/responses`；`GET /r/<id>/v1/models` 返回只含本次模型的列表。

- 请求映射：
  - `instructions` 和 `developer` / `system` 角色的消息并成系统消息。Chat 上游不保证认识 `developer` 角色。
  - `input` 项：
    - `message`（content 为 `input_text` / `output_text` / `input_image`）；
    - `function_call` / `function_call_output`；
    - `custom_tool_call` / `custom_tool_call_output`；
    - `reasoning`（见下面「思考内容」）；
    - 其他托管工具的调用和结果，如 `web_search_call`、`local_shell_call`：丢弃，或转成文字说明。
  - `tools[]`：
    - `function` 一一对应。
    - `namespace` 展开成内嵌的 function。工具名不改，调用时原样回传。
    - `custom` 转成只有一个 `input: string` 参数的函数，`format` 的 grammar 定义附进描述。模型调用后在输出里还原成 `custom_tool_call`。
    - `web_search`、`local_shell`、`image_generation` 等托管工具丢弃，并记日志。
  - `tool_choice`、`parallel_tool_calls` 照传。
  - `text.format` 的 `json_schema` 见任务 6。
  - `reasoning.effort` 在上游声明支持时映射为 `reasoning_effort`，否则丢弃。
  - `store`、`include`、`prompt_cache_key`、`client_metadata` 忽略。
- 流式响应：
  - 事件序列：`response.created`、`response.in_progress`、`response.output_item.added`、`response.output_text.delta`、`response.output_item.done`，最后是 `response.completed`。
    - `output_item.done` 的 item 有三种：`message` 带 `output_text`；`function_call` 带 `call_id` / `name` / `arguments`；`custom_tool_call` 带 `call_id` / `name` / `input`。
    - `response.completed` 带完整的 `output` 和 `usage`：`input_tokens`、`output_tokens`、`total_tokens`、`input_tokens_details.cached_tokens`、`output_tokens_details.reasoning_tokens`。
  - Codex 没收到 `response.completed` 会报错 "stream closed before response.completed"。所以任何上游失败都要以 `response.failed` 收尾，带 `error`。
  - 等待时的保活：用 SSE 注释行，`: keep-alive`。

### 两个上游客户端（provider 侧），都要**流式**

- **Chat Completions**：
  - 请求体带 `stream: true` 和 `stream_options: { include_usage: true }`。
  - 解析 `choices[0].delta` 的 `content`、`reasoning_content`、`tool_calls[index]`（id、name、arguments 分片），以及 `finish_reason`（`stop`、`tool_calls`、`length`）和最后一块的 `usage`。
  - 部分厂商在 `[DONE]` 前不发 usage，此时 usage 缺省为 0，不报错。
- **Anthropic Messages**：
  - 请求带 `x-api-key` 和 `anthropic-version: 2023-06-01`。
  - 解析流式事件：text、thinking、tool_use 的 `input_json_delta`，以及 usage。
- 内部用一种统一的流事件连接两侧：正文增量、思考增量、工具开始、工具参数增量、usage、结束原因、错误。不要写成 N×M 个直连转换。

### 第一版支持的转换

`supports(accept, upstream)` 只在这三对上返回 true：

| harness 侧（accept） | provider 侧（upstream） |
|---|---|
| anthropic-messages | openai-chat |
| openai-responses | openai-chat |
| openai-responses | anthropic-messages |

### 思考内容

- 上游的思考（`reasoning_content`，或 thinking 块）流到下游时这样包装：
  - Anthropic 侧：thinking 块，signature 为桥自己的标记。
  - Responses 侧：`reasoning` item，`summary` 放文本，`encrypted_content` 放桥能还原的编码。
- harness 下一轮带回时还原成上游的形式。DeepSeek 要求工具调用回合内原样带回 `reasoning_content`，跨用户回合则不带。

### 错误

- 上游的 HTTP 状态码原样传给下游，包成对应协议的错误格式：
  - Anthropic 侧：`{ type: 'error', error: { type, message } }`；
  - Responses 侧：流里发 `response.failed`，非流式返回 `{ error: { message, type, code } }`。
- harness 自己的 429 / 5xx 重试照常工作。
- 请求被中断（harness 断开或 `signal`）时取消上游请求。

## 任务 2：搭配判定与引擎接入（`core`）

- **`selection.ts` 新增 `resolvePairing(capabilities, provider | undefined, bridge?)`**，返回：

  ```ts
  {
    pairing?: Pairing
    target?: ProviderConfig   // 直连 / 桥接时上游实际用的入口
    reason?: string           // 不可用时的原因
  }
  ```

  按设计 §2 的五条规则判定。
  - 直连按 harness 的 `providerProtocols` 顺序选协议。
  - 桥接优先选 provider 的主协议做上游。
- **`resolveHarnessSelector`** 改为调用它，返回值多带 `pairing`。
  - 不可用时报错，带上原因，沿用现有错误文本风格。
  - 静态校验 `validateHarnessSelector` / `validateWorkflowHarnesses` 也要考虑桥：给一个可选的 `bridge` 参数，或者放进 `SelectionContext`。
- **`callHarness`**：
  - 桥接时，运行前 `deps.bridge.open(target, pairing.protocol, { model, signal })`。
  - 把 `route.provider` 填进 `request.provider`，`route.env` 合并进 `request.env`。
  - 结束后在 `finally` 里 `close`。
  - `invocation.started` 记录 `provider`（provider 键）和 `pairing`。
  - 没传 `bridge` 时，原本对不上的组合照旧报错。
- **令牌脱敏**：`TAKT_BRIDGE_TOKEN` 的值要进脱敏名单，transcript 和事件里都不能出现。

## 任务 3：harness 适配器

**codex**

- `providerProtocols` 改为 `['openai-responses']`。Chat-only 的 provider 自动走桥。
- 不再生成 `wire_api="chat"`。
- 已知 `modelConfig.contextWindow` 时加 `-c model_context_window=<n>`。

**trae（新）**

- 从 Codex 适配器抽出共用的构造函数。
- id `trae`，displayName `TRAE CLI`，默认命令 `traecli`。
- 能力同 Codex，`providerProtocols: ['openai-responses']`。
- 不选 provider 时就是 TRAE 自带模型，不加 `-c model_provider`。
- 在 `createHarnesses` 里登记，`HarnessOverride.command` 可以改路径。
- 测试用假可执行文件，覆盖：自带模型、自定义 provider 的参数、解析 `item.completed` 的 error 提示。

**pi**

- `customProvider: true`，`providerProtocols: ['openai-chat', 'anthropic-messages', 'openai-responses', 'gemini']`。
- 每次运行在 `os.tmpdir()` 下用 `mkdtemp` 写一个扩展文件，内容是调用 `pi.registerProvider('takt-<id>', {...})`，值都用 `JSON.stringify` 序列化：
  - `baseUrl`；
  - `api`：协议映射见上面背景；
  - `apiKey`：环境变量名。没有 apiKeyEnv 时写一个占位字面量，因为 Pi 要求有这个字段。
  - `headers`；
  - `models: [{ id: model, contextWindow? }]`。
- 运行参数加 `-e <file> --provider takt-<id> --model <model>`。结束后删掉临时目录。
- 不加 `--no-extensions`，用户自己的扩展照常加载。
- 密钥按 Codex 的做法（`readProviderApiKey`）注入子进程 env。
- 原来的 `options.provider`（指 Pi 自己已配的 provider）保留。

**claude-code / claude-acp**

- 不改注入方式。
- 确认桥接时 `ANTHROPIC_BASE_URL` 指向桥的地址，`ANTHROPIC_AUTH_TOKEN` 是令牌。
- 确认 `NO_PROXY` 能传进子进程。

## 任务 4：预设补全（`providers/presets.ts`）

- 按设计 §4 的表格补全 `endpoints`，新增预设 `minimax-cn`、`ark-coding`。原 `minimax` 改成国际站地址。
- 每条加来源注释，写官方文档地址，与现有注释同一风格。
- 不登记未核实的入口。
- 现有测试按新预设更新。

## 任务 5：搭配矩阵 API 与测试

**`GET /api/pairings`**

- 返回 `PairingInfo[]`：每个已登记 harness × [自带（`provider: null`）, 本空间每个 chat provider]。
  - embedding 用的 provider 不算。只被 embedding 模型引用的 provider 不列。
- 某个 harness 不可用（未安装、已停用）时，这一行全部为 `unavailable`，原因是它的不可用原因。

**harness 可用性缓存**

- 现在 `/api/harnesses` 每次都去启动各个 CLI 探测，约 2.25 秒。
- 改为在 serve 进程里缓存 `available()` 的结果 60 秒。运行时配置 PATCH 后作废。
- `/api/harnesses` 和 `/api/pairings` 共用这份缓存。

**`POST /api/space/runtime/test` 的 `pairing`**

- 必须 `allowBilled`。
- 在临时目录里以只读方式跑一次最小任务：「只回复 OK」，超时 120 秒。
- 返回结论、延迟、usage 摘要，以及实际走的 pairing（自带 / 直连 / 桥接）。
- 去掉 runtime-test.ts 里现在的「搭配测试尚未实现」。

**serve 和 CLI 的组装**

- 进程里只创建一个 `createProviderBridge()`，传给引擎的 `bridge`。
- 进程退出时 `close()`；测试收尾也要 close。

## 任务 6：桥上的结构化输出降级

- Responses 入口的请求带 `text.format = { type: 'json_schema', … }` 时，上游不一定支持 `json_schema`。处理方式：
  - Chat 上游：改为在系统消息末尾附上「最终回复必须是满足以下 JSON Schema 的 JSON」和 schema；不发 `response_format`。
  - Anthropic 上游：同样只附提示。
- 是否满足由引擎校验，校验在下一轮简报里加强。

## 任务 7：测试

**桥**

- 每对转换都要覆盖：纯文本、带一轮工具调用往返、思考内容的流出与带回、上游 4xx / 5xx 透传、上游流中断。
- 每对转换再加一个用例：用 `.taktdev/captures` 结构的请求，断言上游收到的 Chat / Anthropic 请求体，并断言下游拿到的事件序列。
- 令牌错误返回 401，路由关闭后返回 404，`close()` 后端口释放。
- 请求里出现 namespace、custom、托管工具时正确展开、还原或丢弃。

**搭配判定**

覆盖五条规则的表驱动测试：
- claude-code × DeepSeek：直连 anthropic；
- codex × DeepSeek：桥接，responses ← chat；
- codex × anthropic：桥接；
- codex × openai：直连 responses；
- pi × 任意：直连；
- native × 自带：不可用；
- gemini provider × codex：不可用，原因写明协议。

**引擎**

- mock harness 声明只接 `openai-responses`，provider 为 `openai-chat`：断言请求里的 provider 指向桥、env 带令牌，`invocation.started.pairing` 为 bridge。
- 结束后路由已关闭。

**适配器与路由**

- trae、pi 的参数测试，含 Pi 扩展文件内容，以及文件里不含密钥值。
- `/api/pairings` 的路由测试；runtime test `pairing` 的路由测试，用 mock harness。

**回归**：`npm test` 全绿，`npx tsc -b` 通过。

## 交付

- 交付说明只写在最终输出里：做了什么、测试结果、没做什么、已知问题。不要在源码目录放文档。
- 不提交、不推送。
