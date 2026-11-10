# 32 · Harness 目录、模型发现与选择器

> 状态：设计中（2026-11-10）。接着 [31](31-Harness与LLM自由搭配和严格结构化输出.md) 做：31 解决了「协议对不上怎么办」，这篇解决「有哪些模型、哪些 harness 真能接、界面上怎么选」。
> 参考：sub2api 的上游模型同步（实时列表 → 配置兜底 → models.dev 补元数据）；OpenClaw 把 provider、模型、agent runtime 分成三层，模型目录用 models.dev 补元数据、合并而不覆盖手填；Hermes 列模型的缓存策略（过期先用旧的，后台刷新）；Orca、Paperclip 让每个 harness 自己列模型和 effort。

## 1. 结论

- **三层不变**：
  - provider：认证方式、能列哪些模型、模型怎么命名。
  - 模型：一个 provider 里的一个模型 ID，带上下文、推理档等元数据。
  - harness：拿这个模型跑 agent 循环的执行器。OpenClaw 管这一层叫 agent runtime。
  - harness 回答的是「这个模型用什么跑」，不是模型从哪来。
- **模型以发现为主，手填为辅**：
  - provider 的模型实时从列表接口拿，再补元数据。
  - harness 自带的模型（订阅账号、内置额度）由 harness 自己列。
  - 手填只用来补充和覆盖。
- **搭配逐个 harness 核实**：
  - 只登记实测过的注入方式。
  - 这次补齐 DeepSeek Harness（dsh）、OpenCode、Qwen Code，新增 Hermes、OpenClaw 两个适配器。
- **harness 目录说人话**：
  - 一个 harness 一行，带图标、来源说明（「使用个人 Claude 订阅」「走 API：DeepSeek」）和状态。
  - mock 只给测试用，不进界面。
  - native 改名为「直连 API（内置）」。
  - Claude Code 的 CLI 和 ACP 是同一个 agent 的两种接法，在界面上并成一行，接法是一个选项。
  - 内置 harness 不可用时可以隐藏，自定义的可以删除。
- **选择器两级**：
  - 先选 harness，右侧弹出模型面板，带 effort 和标签。
  - 角色、节点、系统角色、管家、Solo 共用这一个选择器。

## 2. 现状的问题

- **模型列表**：
  - 列表只有两个来源：预设里写死的一两个名字（多数已过期），加上手填的别名。
  - provider 的「测试」其实已经调了列表接口（`runtime-test.ts`），但只回报「返回 N 个模型」，结果没有存下来。
- **自带模型**：Claude 订阅、ChatGPT 账号、TRAE 额度这些自带模型没有列表，只能选「默认模型」。
- **能接 API 的 harness**：customProvider 按 harness 写死了。
  - dsh 实际能接：它的 `llm-pi-ai` 插件支持 OpenAI Chat / Responses / Anthropic 三种协议，可以自定义 baseURL、模型和 effort。
  - OpenCode、Qwen Code 也能接。
  - 但这三个的适配器都标成了「不支持」。
  - Hermes、OpenClaw 没有适配器。
- **两个 Claude**：
  - 内置的 `claude-code` 走 CLI（`claude -p --output-format stream-json`）。
  - 本空间加的 ACP 条目走官方的 Claude Agent ACP 适配器。
  - 两个都是 Claude Code，只是接法不同。界面上看起来像两个不同的 harness。
- **mock 和 native 都是 taktflow 自己的实现，不是第三方 harness**：
  - mock：测试替身，按脚本回放事件，不调模型。
  - native：taktflow 自带的最小 agent 循环，直接调 LLM API，没有外部 CLI。

## 3. 模型目录

### 3.1 provider 发现

- **按协议调列表接口**：

  | 协议 | 列表接口 | 说明 |
  |---|---|---|
  | openai-chat / openai-responses | `GET {baseURL}/models` | Bearer 认证 |
  | anthropic-messages | `GET {baseURL}/v1/models` | `x-api-key`、`anthropic-version`；按 `has_more` / `last_id` 翻页 |
  | gemini | `GET {baseURL}/v1beta/models` | 按 `nextPageToken` 翻页 |

- **只留能对话的模型**：
  - 去掉 embedding、语音、图像生成、审核类，判断依据是元数据里的输入输出模态，或 ID 关键字。
  - embedding 单独归类，给知识库用。
- **列不出来时退回预设和手填**：包括不支持列表、401、超时。界面写明原因，并给「重试」。
- **缓存**：
  - 存在 `.takt/cache/models/<provider>.json`，不写进 `takt.config.json`。
  - 6 小时过期。过期后先返回旧的，后台再刷新。
  - 「刷新」按钮强制重新拉。
- **合并，不覆盖**：
  - 优先级：手填 > 发现。上游列成功时预设不再混入（预设里的名字多半已过期），列不出来才用预设兜底。
  - 手填条目覆盖同 ID 的元数据，但不限制发现范围。
  - 上游不再列出的模型标「上游已下架」。已被角色引用的仍然可以选，也仍然能运行。

### 3.2 元数据补全

- **来源顺序**：
  1. 列表响应自带的字段，如 `context_length`、DeepSeek 的 `api_capabilities`。
  2. models.dev（`https://models.dev/api.json`），6 小时缓存。先按 baseURL 主机匹配 provider，再按模型 ID 匹配。
  3. 手填。
- **只补缺，不覆盖前面已有的值**。
- **补的字段**：显示名、上下文窗口、最大输出、是否推理、支持的 effort 档与默认档、输入模态、工具调用、价格。价格只用于成本估算。
- **拉不到 models.dev 就不补**，不报错。离线也能用。

### 3.3 harness 自带模型

适配器可以实现 `listModels()`，结果同样缓存，并带上拉取时间和错误：

| harness | 怎么列 | 带 effort |
|---|---|---|
| Codex | `codex debug models`（JSON：slug、display_name、context_window、supported_reasoning_levels、default_reasoning_level；跳过 `visibility` 为隐藏的） | 有 |
| TRAE CLI | `traecli debug models`（JSON 数组，带推理档）；旧版本退回 `traecli models` | 有（debug models） |
| Claude Code | 固定别名 opus / sonnet / haiku | 本机 help 存在 --effort 时提供五档，默认 high |
| Pi / OpenCode / dsh | 各自的列模型命令或配置；能核实的才接 | 视输出 |

列不出来时，界面显示「使用 harness 默认模型」。额度、负载只在 harness 或 provider 真给数据时才显示，第一版不做，也不显示估算值。

本次接入 Codex、TRAE CLI、Claude Code；其余适配器不实现 listModels。TRAE 已核实为逐行模型 ID 文本，解析时保留大小写。

## 4. 搭配：逐个 harness 核实

| harness | 自带 | 能接的协议 | 注入方式 | 本次 |
|---|---|---|---|---|
| Claude Code（CLI / ACP） | Claude 登录 | anthropic-messages（其他协议按协议桥能力） | 环境变量；`transport=acp` 保留同一 ID | CLI 环回真跑、ACP 安装源码核实；接法切换已实现 |
| Codex | ChatGPT 登录 | openai-responses（chat / anthropic 经桥） | `-c model_providers.*`，env_key 引用密钥 | 已有；环回真跑通过 |
| TRAE CLI | TRAE 额度 | openai-responses | 同 Codex | 已有；环回真跑通过 |
| Pi | Pi 已配的 provider | chat / anthropic / responses / gemini | 临时扩展文件，`${ENV_NAME}` 密钥引用 | 官方源码核实；修正当前版本的密钥引用 |
| DeepSeek Harness（dsh） | DeepSeek 账号；独立 ownReady | openai-chat、openai-responses、anthropic-messages | 临时 `--patch`：`llm-pi-ai` 加 provider，`agent-default-model` 指定模型/effort，`apiKeyEnv` | 已实现；三协议 dump-config 和环回真跑通过 |
| OpenCode（CLI） | OpenCode 已配 | openai-chat、anthropic-messages | `OPENCODE_CONFIG_CONTENT` + `{env:TAKT_OPENCODE_API_KEY}` + `--model provider/model` | 已实现；官方源码核实，待安装后真跑 |
| Qwen Code（CLI / ACP） | Qwen 登录 | openai-chat、openai-responses、anthropic-messages | `OPENAI_*` / `ANTHROPIC_*`，`--auth-type`、`--bare` 和临时 `QWEN_HOME` | 已实现；0.27.1 源码核实，待真跑 |
| Hermes（ACP 预设） | Hermes 已配 | openai-chat | `hermes-acp`；临时 `HERMES_HOME/config.yaml`，provider 用 `key_env` | 已实现；官方源码核实，待安装后真跑 |
| OpenClaw（ACP 预设） | 已配置并运行的 Gateway | 本次不登记外部协议 | `openclaw acp` 连接 Gateway；子进程配置无法覆盖 Gateway | 预设已实现，customProvider=false；缺独立 Gateway 注入与回收验证 |
| Gemini CLI | Google 登录 | 只有 Gemini | — | 只能自带 |
| Cursor Agent / GitHub Copilot / Kimi CLI | 各自账号 | — | — | 只能自带 |
| 直连 API（native） | — | chat / anthropic | 进程内 | 已有 |

- **只登记核实过的**。每种注入方式要有两层测试：
  - 单测：断言实际生成的参数和环境变量。
  - 本机装了这个 CLI 时，再真跑一次最小任务。
- **核实不了的保持「只能自带」**，在输出里写明缺什么。
- **注入不改用户的全局配置**，与 31 一致：用临时文件或环境变量，跑完删掉。Qwen / Hermes 外部 API 模式使用临时用户目录，不保留可续接会话，传入 sessionId 时明确拒绝。
- **证据分级**：本次环回真跑使用本地模拟协议端点，只证明 CLI 注入/解析链路；真实厂商 API 仍需手动验收。源码版本、行号和命令见 [开发简报](../dev/m8-pairing-verify.md)。

## 5. Harness 目录

- **`HarnessInfo` 加字段**：
  - `icon`：图标键。
  - `ownLabel`：自带来源说明，如「使用个人 Claude 订阅」。
  - `ownReady` / `ownReason`：自带账号的独立就绪状态。`available` 只表示执行器可启动；自带未就绪不阻止外部 API 搭配。适配器 available() 同步返回这些字段，未知时不伪造已登录。
  - `install`：未安装时的安装提示。
  - `hidden`：已隐藏。
  - `testOnly`：mock 用。
  - `transports`：Claude Code 的 `cli` / `acp`。
- **图标**：
  - 前端内置一套品牌标识（来源 @lobehub/icons，MIT），按 `icon` 取。
  - 没有对应图标的用首字母。
- **mock**：
  - 不出现在目录和选择器里。
  - 已经指到 mock 的角色照常能跑；设置页提示「这是测试替身」。
- **Claude Code 的接法**：
  - 内置 `claude-code` 支持 `harnessOverrides['claude-code'].transport = 'acp'`，用官方 ACP 适配器跑同一个 agent。
  - 自定义的 Claude ACP 条目在界面上标「Claude Code · ACP 接法」，可以删除。
  - 不自动迁移角色引用。
- **隐藏与删除**：
  - 内置的不可用 harness 可以「隐藏」，用已有的 `harnessOverrides.<id>.disabled`。
  - 列表底部有「显示已隐藏（N）」。
  - 自定义的可以删除。

## 6. 选择器

- **左栏 harness 列表**，每行：
  - 图标和名称。
  - 「推荐」标记：角色默认或系统推荐的那个。
  - 副标题：自带来源，或「未安装 · 安装方法」。
  - 当前选中的模型和 effort。
- **右侧模型面板**：
  - 分组：「自带（使用个人 XX）」，然后是每个能搭的 provider，组名旁标直连 / 桥接。
  - 每行：模型名，加标签（推理、上下文 128K、桥接、已下架）。
  - 选中后显示 effort 档：只列这个模型支持的档，默认档预选。
  - 超过 12 个模型时出现搜索框。
- **不可用的组合默认不显示**。打开「显示不可用」后置灰显示，并给出原因。
- **触发按钮**显示「图标 Harness · 模型 · effort」。

## 7. 接口

本节的目录、发现与缓存已实现；§4 的新增协议注入及 §6 的前端选择器不在本次范围。

- `GET /api/space/runtime/catalog` 返回 `RuntimeCatalog`：
  - `harnesses[]`：HarnessInfo 的新字段，加上 `own`（自带模型列表）和 `accepts`（能接的协议）。
  - `providers[]`：`{ id, displayName, protocols, keyPresent, models, embeddings? }`，embeddings 单独保存向量模型。
  - `pairings[]`：沿用 31 的 PairingInfo。
  - `enrichment: 'ok' | 'unavailable'`：models.dev 元数据是否可用。
  - 同样支持 `/api/s/<space>/space/runtime/catalog`；并行发现，最多等待 2.8 秒，未完成项返回预设及 `error: '正在获取…'`。
- **模型列表 `CatalogList`**：
  - 外层：`{ models, fetchedAt?, source: 'live' | 'cache' | 'preset', error? }`。
  - 每个模型 `CatalogModel`：`{ id, label, contextWindow?, maxOutput?, reasoning?, efforts?, defaultEffort?, input?, toolCall?, price?, origin: 'discovered' | 'preset' | 'manual' | 'harness', alias?, deprecated? }`。
  - `Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`；price 为每百万 token 的美元价格，沿用 ModelConfig 的 input/output/cachedInput。
  - ModelConfig 允许手填 label、maxOutput、reasoning、efforts、defaultEffort、input、toolCall；按厂商 id 合并，保留 alias。
- **刷新**：`POST /api/space/runtime/catalog/refresh`，`target` 为 `{ kind: 'provider' | 'harness', id }`，强制刷新一项。
  - 仅 owner 可调用，返回该项 CatalogList；多空间路径与 GET 相同。
  - provider、models.dev、自带模型缓存均为 6 小时；过期返回旧值并去重后台刷新。provider 地址/协议变化使缓存失效；缺少密钥时不请求上游。
  - provider 列表超时 10 秒，harness 命令超时 20 秒；失败返回预设与错误，不把失败当下架证据。
  - `HarnessAdapter.listModels?(): Promise<CatalogModel[]>` 是可选能力；Codex 解析 JSON，TRAE 解析逐行模型 ID，Claude 固定三个别名并通过本机 help 检测 effort。
  - `HarnessInfo` 增加可选 icon/ownLabel/install/hidden/testOnly；声明式 CLI 无品牌图标，native 无 ownLabel，mock 为 testOnly。`GET /api/harnesses` 默认过滤测试替身，`includeTest=1` 可查看；不改变执行注册表。
- **选择结果沿用 `HarnessSelector`**：
  - 格式：`{ harness, provider?, model, effort? }`，`model` 填厂商模型 ID。
  - 不必先建模型别名。已有别名照常可用。

## 8. 不在第一版

- 额度与负载显示。
- 跨 provider 的同名模型合并。
- 按模型自动挑 harness（OpenClaw 的 auto 模式）。
- 不能运行时注入配置的 harness。比如需要改全局配置文件才能换 provider 的，第一版不接。

本次管家运行配置沿用 HarnessSelector：`provider?: string`、`effort?: Effort`；model 支持别名或厂商 ID。线程创建与 PATCH 使用同一校验，旧 runtime-choices 保持返回模型别名。
