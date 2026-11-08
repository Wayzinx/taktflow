# m6-acp 交付说明

## 按简报编号

1. 已实现 ACP v1 stdio JSON-RPC 双向请求、通知、响应、initialize → session/new → session/prompt。协议版本为离线规范的 1；fs 读写 true、terminal false。MCP 当前为空数组，原因见协议变更请求。
2. 助手消息、工具 start/end、callId、实测 durationMs、工具动词与 stopReason 已映射。思考、计划、上下文占用及成本、压缩按 ID 合并后的状态通过 `[ACP ...]` system 消息保留。没有把上下文占用冒充输入 token，也没有编造压缩前后 token 数。
3. 权限仅选 allow_once；reject、只读写操作、未知目标、越界路径拒绝。每次权限请求（含错误会话、无效请求）留审计消息。文件访问只允许 cwd 与引擎传入的 env.TAKT_WORKSPACE；复用 ToolPaths 校验真实路径、防穿越和符号链接逃逸，写入拒绝硬链接，最后一段使用 O_NOFOLLOW。未知方法返回 -32601。
4. 按声明使用 session/resume 或 session/load；load 的历史仅记 replay，不混入本轮最终答案。模型/effort 只设置 session config options 暴露的候选值，以服务端回读确认 applied，并只上报真实 currentValue。取消先通知 session/cancel，等待 prompt 结束，超时回收独立进程组；覆盖进程崩溃、协议错误、握手超时。
5. available 只做 initialize，不发 prompt；同批探测合并，成功与失败缓存 30 秒。detail 包含 agent 名称、版本、协议及原始声明。resume 按声明，工具事件/两拍按实际观察，模型/effort 按会话选项。无法兑现结构化映射的 usage/cost/compactionEvents 保持 false；mcp/readOnly/sandbox 同样不冒报。
6. 导出 ACP_PRESETS（gemini、claude、codex、opencode、qwen、kimi、goose、copilot）。command 优先于 preset。npm 预设固定核对版本，使用 npx --no-install，探测不会自动安装依赖。
7. createHarnesses 支持 cli/acp 联合配置，修复原联合类型报错。内置 CLI 支持 command/env 覆盖；优先级为每次请求 env > 空间覆盖 env > 工厂 env > 进程 env。disabled 从注册表移除，避免路由和探测停用实现；保留重复 ID 检查。DSH 显式命令不再静默回退到另一个二进制。
8. runtimeHarnesses 返回 source=acp、实际启动命令/命令模板、override、custom；native/mock 不返回命令。接口中的 override.env 值全部遮盖，只保留变量名。
9. 本地假 ACP agent、适配器及文件权限测试、conformance、覆盖与目录测试齐全。conformance 的 expected.usage 改为可选，使未提供 token 用量的协议能接受“缺省”断言，而不是合成零用量。

## 验证

- `npx tsc -b packages/core packages/harness packages/server packages/cli`：通过。
- 兼容回归：23 个文件、565 项通过（ACP、修改过的 CLI 适配器、conformance、catalog）。随后增加 6 项 ACP 边界测试并重跑 ACP 目录：4 个文件、55 项全部通过。
- `npm run demo`：通过；run-20261108-221502-13c4。
- `npm run demo:standard`：通过；run-20261108-221508-915c，含 M5 检查。
- 所有 ACP 测试为本地合成 agent；没有安装/启动真实第三方 agent，没有调用付费模型。demo 使用项目既有 mock 流程，不是实际 ACP 模型验收。

## 没做与已知问题

- 未改 core 协议、m6-receipts、serve 定时任务、server 或 web；未安装依赖，未提交/推送仓库，未派发子 agent/worker，未开 worktree。
- 未实现远程 HTTP/WebSocket、client terminal、agent 斜杠命令、认证交互或沙箱传输。认证需用户预先通过 agent 自身完成。
- 客户端权限与文件检查无法约束 agent 自有文件/终端工具，因此 capabilities.readOnly=false；不能作为只读评测的隔离证明。
- 计划、思考、上下文、压缩、逐次 applied 仍只是 system 审计消息，不声称已接入时间视图、上下文曲线或结构化成本账本。
- 预设来源已通过 ego-lite 核对官方 registry，空间已关闭。GitHub 页面直连超时，因此采用官方注册表的 distribution，而非猜参数。Kimi CLI 已被官方标为 Legacy；预设保留其核实的 `kimi acp` 命令，未冒充新 Kimi Code。

## 协议变更请求（未修改协议文件）

1. `HarnessRequest` 增加有类型的 `mcpServers`，使知识层能显式提供 MCP；当前不存在该入口，不能从 prompt 猜服务器。公共存放区暂复用已有 TAKT_WORKSPACE，可后续补显式 workspaceDir。
2. `HarnessEvent.message` 增加思考标记，或新增独立 thought 事件；增加 plan 事件（完整 entries 替换语义）。现有 role 仅 assistant/user/system，不能表达计划与思考类型。
3. 增加上下文用量事件 `{ used, size, cost?: { amount, currency } }`，与输入/输出 token 记账分开。ACP UsageUpdate 不提供 inputTokens/outputTokens，而现有 Usage 两项都必填；不能把 used 当输入量，也不能用 0 代替未知。
4. 增加按 compactionId 更新的压缩事件（status、summary/error 的缺省/清空/替换语义），或使 CompactionRecord 的 trigger/beforeTokens/afterTokens/dropped 可缺省并补 ID/status。ACP 不提供这些现有必填字段，当前无法诚实生成 compacted。
5. 增加每次调用的模型/effort applied 事件或结果字段。HarnessCapabilities 是适配器共享能力，且引擎在 session config options 出现前记 invocation；不能可靠代表本次设置是否成功。当前仅通过 `[ACP config]` 记录 requested/applied，started 只回报服务端确认值。

## 预设核对来源

- 官方目录：https://agentclientprotocol.com/get-started/agents
- 官方 registry 文档：https://agentclientprotocol.com/get-started/registry
- 官方 distribution（2026-11-08 读取）：https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- 核对版本：Gemini 0.67.0；Claude ACP 0.101.0；Codex ACP 2.5.0；OpenCode 2.2.6；Qwen 0.27.0；Kimi CLI 1.52.0；Goose 1.57.0；Copilot 1.0.107。

## 文件清单

新增：

- `packages/harness/src/acp/{index,client,protocol,events,files,requests,presets}.ts`
- `packages/harness/src/acp/{acp,events,registry,catalog}.test.ts`
- `packages/harness/src/acp/README.md`
- `packages/harness/src/testing/fake-acp-agent.mjs`

修改：

- `packages/harness/src/index.ts`
- `packages/harness/src/{claude-code,codex,dsh}.ts`
- `packages/harness/src/adapters/{stream-cli,gemini-cli,cursor-agent,qwen-code,kimi-cli,opencode,pi}.ts`
- `packages/harness/src/testing/conformance.ts`
- `packages/cli/src/catalog.ts`（仅 runtimeHarnesses 与对应 import）
