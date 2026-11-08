# 开发简报：M6 后端（ACP 适配器、模型与 Harness 配置、回执过期；docs/design/27）

**先读**：`AGENTS.md`、`docs/design/27-形象动效与运行时接入.md`，以及你负责的那一节。ACP 规范的离线副本在 `.taktdev/research/acp/`（overview、initialization、session-setup、prompt-turn、tool-calls、file-system、session-modes、agent-plan、schema），以它为准。

**协议已经加好**，不要改 `packages/core/src/{types,interfaces,api}.ts`；确需改动写进交付说明的"协议变更请求"。本轮新增：

- **types.ts**：`AcpHarnessConfig`、`HarnessOverride`；`TaktConfig.harnesses` 改为 `Array<CliHarnessConfig | AcpHarnessConfig>`，加 `harnessOverrides`；`TaktConfig.lead.receiptTimeoutMinutes`；`HarnessAdapter.available()` 返回值加 `detail`；事件 `task.dispatched` 加 `resendOf / reason`。
- **api.ts**：路由表"模型与 Harness 配置"一节；`HarnessInfo.source` 加 `acp`，加 `command / override / custom`；`ModelInfo.kind`；`RuntimeConfig`、`RuntimeSystemRole`、`SecretSource`、`RuntimeConfigPatch`、`RuntimeTestRequest / RuntimeTestResult`、`ProviderPresetInfo`、`AcpPresetInfo`、`SecretStatus`。

**批次**：第一批 m6-acp ∥ m6-receipts（范围不重叠）；第二批 m6-runtime-config（要用到 m6-acp 的预设与探测）。

**通用要求**：只跑自己范围的测试；完成前跑 `npm run demo` 与 `npm run demo:standard`（不能变红）。旧配置照常可读。错误信息用中文并说明下一步。任何日志、事件、审计、接口返回里都不能出现密钥值。测试里不要真的调用付费模型或联网安装 agent（用假 agent / 假 provider）。

---

## 任务 m6-acp（第一批：ACP 适配器，doc 27 §3）

**负责范围**：`packages/harness/src/acp/`（新）、`packages/harness/src/testing/` 下的假 ACP agent、`packages/harness/src/index.ts`、`packages/cli/src/catalog.ts` 的 `runtimeHarnesses`（不动 `runtimeModels`）、各内置 CLI 适配器接受命令路径覆盖所需的最小改动。

1. **ACP 客户端**：stdio 上的 JSON-RPC 2.0（逐行 JSON；请求 / 响应 / 通知；agent 发来的请求要能回）。`initialize`（protocolVersion 取规范当前值；clientCapabilities：fs 读写为 true，terminal 为 false）→ `session/new`（cwd 为请求的工作目录；mcpServers 为空数组，除非请求里给了）→ `session/prompt` → 收集 `session/update` 直到 prompt 返回 stopReason。
2. **事件映射**：按 doc 27 §3 的表映射到 `HarnessEvent`：消息 / 思考、工具调用两拍（`phase`、`callId`、`durationMs`，ACP 的 tool kind 对到 docs/design/25 的动词）、计划、`usage_update`（用量与上下文窗口）、`compaction_update`（压缩）。stopReason：`end_turn` 成功；`max_tokens / max_turn_requests / refusal` 失败并写原因；`cancelled` 取消。拿不到的值如实缺省，不编。
3. **agent 发来的请求**：`session/request_permission` 按 `AcpHarnessConfig.permissions` 处理（allow：目标路径在工作目录或公共存放区内放行一次，否则拒绝；reject：一律拒绝；`HarnessRequest.readOnly` 时写类一律拒绝），每次都发一条可审计的事件；`fs/read_text_file`、`fs/write_text_file` 只允许工作目录与公共存放区内的路径（防穿越与符号链接逃逸），只读运行拒绝写；不认识的方法回 JSON-RPC method not found。
4. **会话与模型**：agent 声明 `loadSession` 或支持 `session/resume` 时实现续会话，否则 capabilities.resume = false；模型 / effort 只在 agent 通过会话配置项暴露时设置（记 applied），否则 applied: false。取消发 `session/cancel`，超时再结束进程组。进程退出、协议错误、握手超时都要有明确中文原因。
5. **能力**：从 initialize 的 agentCapabilities 与实际收到的更新换算 `HarnessCapabilities`；`available()` 做一次握手（带超时，缓存结果），`detail` 写 agent 名称 / 版本 / 协议版本 / 关键能力。
6. **预设**：导出 `ACP_PRESETS: AcpPresetInfo[]`（至少 gemini、claude、codex、opencode、qwen、kimi、goose、copilot；命令与安装说明以各项目当前文档为准，拿不准的写进交付说明，不要猜一个看起来对的参数）。`AcpHarnessConfig.preset` 给了而 `command` 没给时用预设命令。
7. **注册与覆盖**：`createHarnesses` 接受 `cli | acp` 两种自定义 harness；应用 `harnessOverrides`：`command` 替换内置 CLI 的可执行文件、`env` 合并、`disabled` 从注册表去掉（或标不可用并写原因，二选一，说明理由）。修好 `index.ts` 现有的联合类型报错。
8. **目录**：`runtimeHarnesses` 输出 `source: 'acp'`、`command`（覆盖后的实际命令）、`override`、`custom`（cli / acp 自加的为 true）。
9. **测试**：假 ACP agent（`packages/harness/src/testing/`，node 脚本，可按场景回放：正常一轮、工具两拍、计划、用量、压缩、请求权限、读写文件越界、崩溃、拒绝）；适配器单测 + 进 conformance 套件；覆盖规则单测；目录输出单测。

## 任务 m6-receipts（第一批：回执过期与重发记账，doc 27 §5）

**负责范围**：`packages/core/src/lead/`、serve 的定时任务所在文件（等人时限的定时在哪就加在哪）、必要时 `packages/core/src/steward/tools.ts` 里转达超时的缺省值（只为口径一致，不改行为）。

1. 过期：定时把超过 `lead.receiptTimeoutMinutes`（缺省 30，与管家转达的缺省值共用一个常量）仍是"已发出"的任务标为过期——追加一条同 taskRunId 的 task 消息（`receipt.status: 'expired'`，hops / chain 沿用），不改原消息；幂等（已过期、已接手、已开始、已完成的不再动）。
2. 不确定：serve 启动时扫描群聊，回执停在"已发出 / 已接手"而对应任务运行不存在、或运行没结束但不在本进程里执行的，追加 `uncertain`，note 写"服务重启，可能已送达，重发前先看群聊"。
3. 重发记账：`resendTask` 成功后在原任务的父运行（派发原任务的 Lead 运行；从原运行状态或原派发事件里找）追加 `task.dispatched`，带新 `taskRunId`、`resendOf`（原任务运行 id）与 `reason`。找不到父运行时不报错，交付说明里写清楚哪些情况找不到。
4. 测试：过期（时间可注入）、幂等、重启标不确定、重发后父运行有派发事件且 web 时间线需要的字段齐全。

## 任务 m6-runtime-config（第二批：模型与 Harness 配置，doc 27 §4）

**负责范围**：`packages/core/src/runtime-config/`（新）、`packages/core/src/secrets/`（新）、`packages/core/src/engine/harness.ts` 与 `packages/core/src/eval/read-only-call.ts` 里取密钥的那几行、`packages/cli/src/catalog.ts` 的 `runtimeModels`、server 新路由文件与注册、`packages/cli/src/commands/serve.ts` 的热加载、命令注册表（如需 `runtime.patch` 命令供管家提案使用）。

1. **读视图**：`GET /api/space/runtime` → `RuntimeConfig`；`revision` 为这几段的规范化 JSON 哈希；`keys` 列出所有 provider 的 apiKeyEnv 来源；`presets` 来自 harness 包的 provider 预设与 `ACP_PRESETS`。
2. **写**：`PATCH /api/space/runtime`（owner）：baseRevision 不一致 409；按段应用（null 删除）；校验（模型指向的 provider 存在、协议合法、角色 / 系统角色用的 harness 存在且未停用、自定义 harness id 不与内置冲突、ACP 有 preset 或 command、embedding 模型有维度……）失败 400 并指出字段与下一步；takt.config.json 原子写、保留其他段与键顺序；进空间审计（只记改了哪些键，不记密钥）。
3. **热加载**：写成功后 serve 重建该空间的运行时（harness 注册表、模型解析、目录缓存失效）；正在跑的节点继续用旧的；新节点、Lead、管家用新的。
4. **测试连通**：`POST /api/space/runtime/test`：provider 调列模型接口（不计费，超时 10s）；model 只有 `allowBilled` 才发一次 1 token 请求，否则 400 说明；harness 调 `available()` 并带回 `detail`。结果如实写 `billed`。
5. **密钥**：本机密钥库 `~/.config/takt/secrets.json`（路径可由环境变量覆盖以便测试；目录 0700、文件 0600；原子写）；`PUT / DELETE /api/secrets/:name`（owner，名字只允许环境变量名格式）；取值顺序：进程环境变量 → 本机密钥库；engine 与只读调用注入密钥改走这个解析；`runtimeModels` 的 `keyPresent` 与 `kind` 同步；redact 能覆盖本机密钥值。
6. **测试**：读视图、补丁与校验、409、热加载后新节点用新 harness、测试连通（假 provider / 假 harness）、密钥库权限与不回传、redact。
