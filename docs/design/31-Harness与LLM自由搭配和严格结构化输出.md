# 31 · Harness 与 LLM API 自由搭配、严格结构化输出

> 状态：第一版已实现。协议桥与搭配 e39bd18（docs/dev/m8-backend-c7.md）；严格结构化输出 65abe33（docs/dev/m8-backend-c8.md）；设置页搭配矩阵、统一选择器 e03aed7。
> 真实验收（DeepSeek）：claude-code / codex / trae 的直连与桥接各跑通一次工具往返，三者的原生结构约束（`--json-schema` / `--output-schema`）各跑通一次。Pi 本机未安装，只有单测。
> 范围：第一版覆盖 Claude Code（CLI + ACP）、Codex、TRAE CLI、Pi 四个 harness，以及国内外常见的 LLM API。
> 补充：管家换 harness × 模型、保存角色时的搭配校验，与节点调用用同一套判断（补全 provider 预设入口、可经协议桥）；管家只列接 MCP 的 harness（Claude Code、Codex、TRAE CLI；Pi 不接 MCP），Codex / TRAE 的 takt MCP 工具设为免审批（exec 审批策略是 never，否则一律被拒）；三者接 DeepSeek 各真跑通一次管家工具调用。planner 条目的 `params.paths` 展开前先和改代码节点的写权限核对。

## 1. 结论

- **任何 harness × 任何 LLM API 都能搭**。协议对得上就直连；对不上，由 taktflow 进程里内置的协议桥自动转换。用户不用另起 claude-code-router、LiteLLM 这类网关，也不用改配置。
- **每个 harness 走它自己原生的注入方式**：
  - Claude Code 用环境变量；
  - Codex / TRAE 用 `-c model_providers.*`；
  - Pi 用一次性扩展文件注册 provider。
  - 都不改用户的全局配置文件（`~/.claude`、`~/.codex`、`~/.trae`、`~/.pi`）。
- **不选 provider 就是「自带」**：harness 用自己的登录和默认模型，即 Claude 订阅、ChatGPT 账号、TRAE 内置模型、Pi 里已配好的 provider。
- **设置页给一张搭配矩阵**，标出每个组合是 自带 / 直连 / 桥接 / 不可用，并给出原因。组合可以真跑一次测试（计费，需要确认）。角色、节点、系统角色的选择器只列能用的组合。
- **结构化输出强校验**：
  - harness 支持就用原生约束：Claude Code 的 `--json-schema`、Codex / TRAE 的 `--output-schema`。
  - 不论有没有原生约束，引擎都按完整 JSON Schema 校验，再跑语义校验（如评审回应逐条对应）。
  - 不通过时把错误列表发回给模型追问修正，默认最多 2 次；仍不通过，节点以 `output.invalid` 失败，可以重试。

## 2. 协议对照

现在的问题：

- `providerFor` 只做「主协议或 endpoints 里有 harness 能接的」，对不上就报错。
- Codex 声明了 `openai-chat`，但本机 codex-cli 0.159.2 和 TRAE CLI 0.213.1 都已拒绝 `wire_api = "chat"`（实测报错 "is no longer supported"）。所以 Codex + DeepSeek 现在其实跑不起来。
- Pi 的适配器关掉了 customProvider。
- 预设只给 DeepSeek 登记了第二个协议入口。

| harness | 能直接说的协议（按偏好） | 自带 | 注入方式 |
|---|---|---|---|
| claude-code / claude-acp | anthropic-messages | Claude 登录 | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 各档 `ANTHROPIC_*_MODEL`（已有 `claudeProviderEnv`） |
| codex | openai-responses | ChatGPT / `~/.codex` | `-c model_provider=… -c model_providers.<id>.{name,base_url,env_key,wire_api="responses"}`、`-m` |
| trae（新） | openai-responses | TRAE 内置（`trae` provider） | 同 Codex。TRAE CLI 是 Codex 分支，`exec --json` 事件格式一致（已实测） |
| pi | openai-chat、anthropic-messages、openai-responses、gemini | Pi 已配置的 provider | 生成临时扩展 `pi.registerProvider()`，再用 `-e <file> --provider <id> --model <model>`。apiKey 只写环境变量名 |
| native | openai-chat、anthropic-messages | 无（必须选 provider） | 进程内 |

搭配判定 `resolvePairing(harness, provider)`：

1. 没选 provider：harness 不要求 provider 时为 **自带**，否则不可用（native）。
2. harness 不支持 customProvider：**不可用**，原因是「该 harness 只能用自带模型」。
3. provider 提供的协议（主协议 + endpoints）与 harness 能说的有交集：**直连**。按 harness 的偏好顺序挑协议。
4. 没有交集，但协议桥支持其中某一对（harness 说的 ← provider 提供的）：**桥接**。
5. 都不行：**不可用**，原因写明两边各自的协议。

## 3. 内置协议桥

- **形态**：
  - 进程内的 `node:http` 服务，只监听 `127.0.0.1` 的随机端口，第一次用到时才启动。
  - 每次调用开一条路由 `/r/<routeId>`，配一个一次性令牌。harness 拿令牌当 API key。令牌不对一律 401，所以本机其他进程用不了。
  - 调用结束就关闭路由。
  - 上游密钥在桥里按 provider 的 `apiKeyEnv` 读，来源顺序与现在相同：环境变量优先，其次本机密钥库。密钥不进 harness 进程，也不进任何文件。
- **第一版支持的转换**（harness 侧 ← provider 侧）：

  | harness 侧 | provider 侧 | 典型组合 |
  |---|---|---|
  | anthropic-messages | openai-chat | Claude Code + 只有 Chat 接口的 API（本机 GPT 代理、通义千问、SiliconFlow …） |
  | openai-responses | openai-chat | Codex / TRAE + DeepSeek、Kimi、GLM、Qwen、Ollama … |
  | openai-responses | anthropic-messages | Codex / TRAE + Anthropic 官方 |

  - Gemini 协议第一版不做转换。Pi 能直接说 gemini；其他 harness 接 gemini 显示「不可用」。
- **做法**：
  - 两种入口（Anthropic Messages、OpenAI Responses）先翻译成同一个内部请求。再由两种上游客户端（Chat Completions、Anthropic Messages）发出。
  - 上下行都**流式**：上游的增量（正文、思考、工具调用参数）实时转成下游协议的事件。等待上游时发保活事件，避免 harness 超时。
  - 工具：
    - 函数工具一一对应。
    - Codex 的 custom / freeform 工具（如 `apply_patch`）转成只有一个 `input` 字符串参数的函数，结果再还原。
    - 上游做不了的托管工具（`web_search`、`local_shell`、图片生成）丢掉，并在日志里记一条。
  - 思考内容：
    - 上游的 `reasoning_content` / thinking 转成下游的 thinking 块或 reasoning item。
    - 下一轮带回来时再还原，因为 DeepSeek 在工具调用回合里要求原样带回。
  - 错误：
    - 上游的 HTTP 状态原样传给下游，包成对应协议的错误格式，这样 harness 自己的 429 / 5xx 重试照常工作。
    - 错误消息脱敏。
  - Codex 可能请求的 `GET /models`，桥返回只含本次模型的列表。`count_tokens` 在本地估算。
- **可观测**：
  - `invocation.started` 记 `provider` 和 `pairing`（mode / protocol / upstream）。
  - 运行页节点详情显示「Codex → 桥接 → DeepSeek（Chat）」。

## 4. 预设补全

只登记核实过的入口，每条注明来源。

| 预设 | 主协议 | 其他入口 |
|---|---|---|
| openai | openai-chat `https://api.openai.com/v1` | openai-responses 同地址 |
| deepseek | openai-chat | anthropic-messages `https://api.deepseek.com/anthropic`（已有） |
| moonshot | openai-chat `https://api.moonshot.cn/v1` | anthropic-messages `https://api.moonshot.cn/anthropic` |
| zhipu | openai-chat `https://open.bigmodel.cn/api/paas/v4` | anthropic-messages `https://open.bigmodel.cn/api/anthropic` |
| minimax-cn / minimax（国际） | openai-chat `https://api.minimaxi.com/v1` / `https://api.minimax.io/v1` | anthropic-messages `…/anthropic` |
| ark | openai-chat `https://ark.cn-beijing.volces.com/api/v3` | openai-responses 同地址 |
| ark-coding（方舟 Coding Plan） | anthropic-messages `https://ark.cn-beijing.volces.com/api/coding` | — |
| openrouter | openai-chat `https://openrouter.ai/api/v1` | openai-responses 同地址；anthropic-messages `https://openrouter.ai/api` |
| ollama | openai-chat `http://localhost:11434/v1` | anthropic-messages `http://localhost:11434` |

- 未核实的不登记，例如 DashScope 的 Anthropic 入口。用户可以在 provider 的 endpoints 里自己加。

## 5. 严格结构化输出

- **原生约束**：
  - claude-code 加 `--json-schema`，从结果事件的 `structured_output` 取值。
  - codex / trae 加 `--output-schema <临时文件>`。
  - 以上三者声明 `structuredOutput: true`。
  - OpenAI 的严格模式要求每个对象 `additionalProperties: false`，且列全 `required`。适配器先把 schema 转成严格形态：可选字段改为可为 null 且列入必填。拿到结果后再删掉这些 null。
  - 走桥接时，上游不一定支持 `json_schema`。桥把它降级为提示词里的格式要求，由下面的校验兜底。
- **完整校验**：
  - `validateSchema` 换成 Ajv（draft 2020-12，`allErrors`）。
  - 覆盖 `required`、`additionalProperties`、`items`、`enum`、`const`、`minItems`、`pattern`、`oneOf` / `anyOf` 等。
  - 错误统一成「路径 + 原因」的中文列表。
  - 新增 `schemaErrors()` 返回列表；`validateSchema()` 保持抛错语义。所有现有调用点不改。
- **修正追问**：
  - 校验或语义校验（如评审回应逐条对应、完成标准）失败时，记 `output.invalid`（第几次、错误列表、输出摘录）。
  - 然后用同一 harness / 模型追问修正：
    - 能续聊就续聊；
    - 不能就新开一次只读调用，带上原输出和错误。
    - 两种都要求「只输出修正后的完整 JSON，不改文件」。
  - 通过记 `output.repaired`。
  - 次数由 `config.output.repairs` 设定，默认 2。用完仍不过，节点以 `output.invalid` 失败。
- **提取**：
  - 原生约束时，最终回复本身就是 JSON。
  - 否则取最后一个闭合的 json 代码块；整段回复本身是合法 JSON 也接受。

## 6. 界面

- **设置页「模型与 Harness」**：
  - 重做布局：harness 卡片网格不溢出，长命令截断显示，悬停看全文。
  - 加「搭配」矩阵：行是 harness（含自带），列是 provider；格子显示 自带 / 直连 / 桥接 / 不可用。
  - 点格子看原因；能用的组合可以「测试」，计费，需要确认。
- **统一的「Harness + 模型」选择器**（角色、节点、系统角色共用）：
  - 先选 harness；模型列表分组为「自带」和各 provider 的模型别名。
  - 每项标出直连 / 桥接；不可用的置灰，并给出原因。

## 7. 不在第一版

- 桥的 Gemini 协议入口或上游。
- Responses 作为上游。目前没有只提供 Responses 的常见 API。
- 每个 provider 的能力探测，比如是否支持 `json_schema`、图片输入。
- 其他 harness（Gemini CLI、Qwen Code、Kimi CLI、OpenCode …）的自由搭配。这些走 ACP，或保持自带。
