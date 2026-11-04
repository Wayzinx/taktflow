# 09 · 多 harness 与模型路由

## 解决什么问题

- 模型决定上限，harness 决定能发挥多少。不同环节偏好的组合正好相反：方案和用例生成适合 Claude Code + Opus，写代码和修 bug 适合 Codex + GPT。
- 任何一家 harness 都可能不可用（限流、登录过期、额度用完）。原型里 worker 通道多次 401 / 429，靠人改派。
- 生成者和验证者用同一家模型，容易"自己给自己放水"。

## 设计

**两层正交**：
- **harness 层**：谁来跑 agent loop（Claude Code、Codex、DeepSeek Harness、自研……）。实现 `HarnessAdapter`。
- **模型层**：同一个 harness 下用哪个模型、什么推理强度。写在 `HarnessSelector.model / effort`。

**选择优先级**：节点上的 `harness` > 角色档案的 `harness` > `takt.config.json` 的 `roles` 默认值 > 全局默认。

**降级链**：`fallback: [...]` 按顺序尝试。适配器 `available()` 失败、或运行返回可重试错误（429 / 503 / 登录失效）时切下一个，记一条 `log` 事件说明原因。不可重试的错误（权限、业务错误）不降级。

**会话级选择**：一个会话跑到底，不在中途换 harness；想换就拆成两个节点，中间只传落盘的产物。

## 适配器

> 完整的支持矩阵、声明式 CLI 适配、native harness 和 LLM API 接入见 [13 · 扩展性与生态](13-扩展性与生态.md)。

| id | 调用方式 | 结构化事件 | 状态 |
|---|---|---|---|
| `mock` | 进程内，按脚本化剧本返回 | 全部 | MVP，用于测试和演示 |
| `claude-code` | `claude -p --output-format stream-json [--resume <id>] [--model]` | 消息 / 工具调用 / 用量 / session_id | MVP |
| `codex` | `codex exec --json -C <cwd> [-m] [resume <id>]`，stdin 置空 | 消息 / 工具调用 / 用量 / thread id | MVP |
| `dsh` | `dsh --profile headless --json "<task>"`（DeepSeek Harness） | NDJSON 运行事件 | MVP（需要先登录 DeepSeek 账号） |
| `traecli` | `traecli exec` | 待确认 | 后续 |

适配器负责：拼命令、流式解析事件、超时和取消、把原始 transcript 落到 `runs/<RUN>/transcripts/<nodeId>/`、把结构化输出按 `resultSchema` 提取和校验。

## 默认角色分工（可在配置里改）

| 角色 | 默认 | 原因 |
|---|---|---|
| pm / architect / test-designer | claude-code | 读懂再写，表达接近人，评审成本低 |
| dev / automation | codex | 指令遵循严，长任务更稳 |
| judge / reviewer | 与 dev 不同厂商 | 生成和验证分离 |
| 小模块 / 单测 | dsh（DeepSeek） | 成本低 |

## 评测（后续）

选型表是会过期的结论：固定评测集 + 多次运行 + 成对比较，新模型出来重跑，效果更好、成本可接受、没有真回归才切换，切换写进配置历史。
