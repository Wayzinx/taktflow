# 开发简报：扩展性（M1 第一批）

**背景**：先读 `docs/design/13-扩展性与生态.md`。协议已经加好（只增不改）：`HarnessCapabilities`、`HarnessAdapter.capabilities`、`HarnessSelector.provider`、`HarnessRequest.provider / tools`、`CliHarnessConfig`、`ProviderConfig / ModelConfig / ModelProvider / ChatRequest / ChatResponse / ToolSpec / ToolCall`、`TaktPlugin`、`definePlugin`、`TaktConfig.plugins / harnesses / providers / models`，以及 `api.ts` 的 `HarnessInfo / ModelInfo` 和 `/api/harnesses`、`/api/models`。

本轮拆成 4 个任务，各自的负责范围不重叠。

## 任务 ext-providers（packages/harness/src/providers/**、packages/harness/src/native/**）

1. `providers/presets.ts`：厂商预设表（id → protocol + 默认 baseURL + 常用模型示例）：openai、anthropic、deepseek、moonshot、zhipu、dashscope、ark（火山方舟）、minimax、siliconflow、openrouter、azure-openai（需用户填 baseURL）、ollama、vllm、lmstudio、litellm。baseURL 以各厂商官方文档为准；拿不准的写 `undefined` 并要求用户配置，不要编造。
2. `providers/openai-chat.ts`：基于 `fetch` 的 `/chat/completions` 客户端：消息、tools（function calling）、`response_format: json_schema`（不支持时降级为提示词要求 JSON）、usage、超时与 AbortSignal、429/5xx 指数退避重试（最多 3 次）、错误信息里保留状态码。
3. `providers/anthropic-messages.ts`：`/v1/messages` 客户端：system 单独字段、tool_use / tool_result 块与 ToolCall 的互转、usage（含 cache）。
4. `providers/index.ts`：`createProvider(id, config)` 按 protocol 选择实现；`resolveModel(selector, config)` 把模型别名解析成 `{ providerId, providerConfig, modelId, price, contextWindow }`。
5. `native/`：`createNativeHarness({ providers, models })`，capabilities 全部为 true（customProvider 除外，它本来就直连 provider）。agent loop：
   - 工具：`read_file`、`write_file`、`edit_file`（精确字符串替换）、`list`、`grep`、`bash`（仅当 `req.tools.allowBash`）；路径限制在 cwd 内；写操作在工具层按 `req.tools.writeScope` **前置校验**，越界返回工具错误给模型（不执行）。
   - 每轮发 `message` / `tool_call` / `usage` 事件；最多 50 轮；超出上下文窗口 80% 时做一次压缩（把早期工具结果替换为摘要），发 `compacted` 事件。
   - `req.resultSchema`：最后一轮要求按 schema 输出，provider 支持就原生透传；结果放 `structured`。
   - 成本：按 ModelConfig.price 计算 costUsd。
6. 测试：用本地 `http.createServer` 模拟 openai-chat 和 anthropic-messages 两种接口（含 tool call 往返、429 重试、json_schema）；native loop 用模拟 provider 跑"读文件 → 改文件 → 输出 JSON"，并验证越界写被拒绝。

## 任务 ext-adapters（packages/harness/src/adapters/**、packages/harness/src/testing/**）

1. 给已有的 claude-code、codex、dsh、mock 补 `capabilities`；claude-code 和 codex 实现 customProvider：
   - claude-code：`req.provider` 为 anthropic-messages 协议时注入 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（取 apiKeyEnv 的值）、`ANTHROPIC_MODEL`；
   - codex：`req.provider` 为 openai-chat / openai-responses 协议时追加 `-c model_provider=<id> -c model_providers.<id>.name=<id> -c model_providers.<id>.base_url=<baseURL> -c model_providers.<id>.env_key=<apiKeyEnv> -c model_providers.<id>.wire_api=<chat|responses>`；
   - 协议不匹配时 run 直接返回 ok:false 和明确错误。
2. 新适配器（参数以 `docs/design/13` 的支持矩阵为准；本机没有安装的，只实现解析器 + 录制样例测试，available() 检测可执行文件）：`gemini-cli`、`cursor-agent`（事件格式与 Claude Code 相同，复用其解析器）、`qwen-code`、`kimi-cli`、`opencode`。
3. `cli-generic.ts`：`createCliHarness(config: CliHarnessConfig)`：命令模板占位符替换、三种 prompt 传入方式、jsonl 字段映射（点路径取值）、text 输出直接作为 finalText。
4. `testing/conformance.ts`：导出 `runHarnessConformance(name, { parse, fixtures })` 一组 vitest 用例：解析录制事件流得到 started / message / tool_call / usage / 最终文本；结构化输出提取；错误分类关键词保留；超时取消（对能启动进程的适配器）。所有内置适配器都用它测一遍。`package.json` 的 exports 增加 `./testing` 子路径（只改 packages/harness/package.json 的 exports 字段）。
5. `index.ts`：`createHarnesses({ config, projectDir, providers })` 返回内置 + `config.harnesses` 里声明的 CLI harness + native。

## 任务 ext-core-cli（packages/core/src/plugins/**、packages/core/src/engine/** 的相关部分、packages/cli/src/**、packages/server/src/**）

1. core `plugins/load.ts`：`loadPlugins(config, projectDir)`：按名称从项目 node_modules 或相对路径加载（`.ts` 用 cli 传入的导入函数，core 本身不依赖 tsx），校验 `apiVersion === 1`，合并 harnesses / providers / knowledge / workflows / roles；名称冲突报错。
2. 引擎：
   - 选择 harness 时把 `selector.model` 通过 `config.models` 解析（别名 → 厂商模型 ID），`selector.provider` 或模型所属 provider 解析成 `req.provider`；harness 没有 `customProvider` 能力却配置了 provider → 节点失败并写明原因（workflow 加载时也做同样检查，给出早失败）。
   - 能力降级：`session: 'resume'` 而 harness 无 resume → 新会话，并在 prompt 里注入上一轮产物清单；无 `structuredOutput` → 照旧从文本提取；无 `usage` → 用 estimateTokens 估算并在 usage 上标注 estimated（写进事件 data 的 note 字段即可）。
   - native harness 节点：把 writeScope 和 allowBash（角色 frontmatter 新增可选字段 `allowBash`）放进 `req.tools`。
3. CLI：`takt harness ls`（表格：id、来源、可用、原因、能力、默认角色）、`takt models ls`、`takt doctor`（检查 Node 版本、配置合法性、每个 harness 可用性、每个 provider 的 apiKeyEnv 是否存在（不打印值）、插件加载结果；任何错误退出码 1）。加载 config 时调用 loadPlugins。
4. server：实现 `/api/harnesses`、`/api/models`。
5. 测试：插件加载（本地 .ts 插件注册一个 harness 和一个 provider）；模型别名解析；customProvider 校验早失败；doctor 在缺环境变量时报错。

## 任务 ext-web（packages/web/**，Claude 负责）

新增"设置"页：harness 卡片（可用性、原因、能力矩阵用小图标表示、默认角色）、模型表（别名、provider、协议、上下文窗口、价格、密钥是否已配置）；mock 数据同步补齐。风格与现有页面一致。

## 完成定义（全部任务）

`npm run typecheck`、`npx vitest run`、`npm run demo`、`npm run build -w @taktflow/web` 通过；`npm run takt -- doctor --project examples/hello-delivery` 能输出完整报告（没有安装的 harness 显示不可用，不算失败；示例配置里不放需要密钥的 provider）。

## M0 收尾项（随本轮一起做）

协议已加好（可选字段）：`Expansion.nodes`、`SnapshotNode.form / choices / checks[].threshold`、`NodeContext.signal`、`RunDetail.stages`、`AttentionItem` 回答编码注释。

**后端（并入 ext-core-cli）**
1. 引擎把 planner 展开出的节点定义写进 `Expansion.nodes`；`buildRunGraph` 和 stale 传播都从它读，删掉 engine.json 的临时方案（保留对旧运行数据的兼容读取即可）。
2. `snapshotWorkflow` 填充 human 节点的 `form / choices` 和 rubric 检查的 `threshold`。
3. 引擎给 `NodeContext.signal` 传入运行的 AbortSignal；取消运行时脚本函数能结束自己启动的子进程。模板 `templates/workflows/sdlc.workflow.ts` 的 `runCases` 用这个 signal（`execFile` 的 `signal` 选项），并同步到 `examples/hello-delivery/.takt/workflows/sdlc.workflow.ts`（两份只允许 design 节点的 knowledge 查询不同）。
4. server 的 `RunDetail` 填 `stages`（用 core 的 `stageProgress`）。
5. 用量口径统一：`summarizeRun`、`GraphNode.usage` 都按事件日志里全部 `node.finished` 的 usage 累加（loop 每一轮都算），与 RequirementSummary / metrics 一致；加测试锁住"同一运行在运行列表、运行页、需求页显示的 token 相同"。

**Web（并入 ext-web）**
1. 运行页阶段条改用 `RunDetail.stages`，删除 `lib/stage.ts` 里复制 core 规则的 `computeStages`。
2. 门禁 Tab 画 rubric 阈值线（`SnapshotNode.checks[].threshold`）。
3. 运行页头部的 token 直接用 server 返回的运行用量（后端口径统一后不再前端自算）。
