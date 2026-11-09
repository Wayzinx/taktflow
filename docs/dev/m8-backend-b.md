# 开发简报：M8 后端 B（管家会话管理、管家换 harness 与模型、进展去重；docs/design/30 §2）

**先读**：`AGENTS.md`、`docs/design/30-打磨一致性会话与自动化.md`（§2）、`docs/design/22`（管家原则）、`docs/design/28`（Solo）。

**协议已经加好**，不要改 `packages/core/src/{types,interfaces,api}.ts`；确需改动写进交付说明的"协议变更请求"。本轮新增：
- api.ts 路由表"管家"一节：`GET /api/steward/threads?archived=1`、`PATCH /api/steward/threads/:id`、`DELETE /api/steward/threads/:id`、`GET /api/steward/runtime-choices`、`POST /api/steward/mcp`；
- `StewardThread` 新字段（`pinnedAt`、`archivedAt`、`titleEdited`、`runtime`、`status`、`error`、`messageCount`、`spaceId`、`requirementId`、`requirementTitle`），`StewardRuntime`、`StewardThreadPatch`、`StewardRuntimeChoice`；
- `Digest.progress[].more`；
- types.ts `HarnessRequest.mcpServers`。

**通用要求**：
- 错误信息用中文并说明下一步；测试里不调用付费模型；
- 完成前跑 `npm run demo`、`npm run demo:standard`、`npm run demo:steward`，都不能变红。

**负责范围**：`packages/core/src/steward/`、`packages/server/src/`（steward 路由、`index.ts` 里管家的接线）、`packages/harness/src/`（只为任务 4 的 MCP 参数）、相应测试。**不要动 `packages/web/`**，前端同时在改。

---

## 任务 1：会话管理

1. **PATCH**：
   - `title` 去首尾空白后 1–80 字，写入并置 `titleEdited: true`；
   - `pinned: true/false` 写 / 清 `pinnedAt`；`archived` 写 / 清 `archivedAt`；
   - `runtime` 见任务 3，`null` 清掉。
   - 只改调用者自己的会话（沿用现有按用户隔离与 id 校验），返回更新后的 `StewardThread`。
2. **DELETE**：
   - 删 `threads/<id>.json` 与 `.jsonl`；
   - 会话里有 `pending` 提案时返回 409："这个会话还有 N 个待决定的提案，先处理或归档"；
   - 动态（feed）里指向它的条目保留，前端点到时显示"会话已删除"。
3. **列表**：
   - 默认不含已归档，`?archived=1` 只列已归档；
   - 排序：置顶的在前（按 `pinnedAt` 倒序），其余按 `updatedAt` 倒序；
   - 自动起名在 `titleEdited` 时不再覆盖标题。
4. **状态**：
   - 开始回复时写 `status: 'replying'`，正常结束清掉；
   - 失败写 `status: 'error'` 与可读的 `error`；
   - 服务启动时把残留的 `replying` 改成 `interrupted`；
   - 用户再发消息时清掉 `error` / `interrupted`。
5. **归属与计数**：
   - 每次追加消息后更新 `messageCount`；
   - 按 `context` 与消息里引用（`StewardContextRef`、实体块的 ref）里出现最多的需求，写 `spaceId` / `requirementId` / `requirementTitle`；
   - 只引用了空间的，只写 `spaceId`。
   - 老会话没有这些字段，读取时按需补算一次并回写，不要求迁移脚本。

## 任务 2：进展去重

- digest 生成时，`progress` 按 `spaceId + requirementId` 只留最新一条，被折叠的条数写 `more`；
- 列表按 `at` 倒序；
- 摘要句里的"N 项进展"按去重后的条数算。
- 管家 Solo 首页与总览横幅都用同一份 digest，不要在两处各去一遍重。

## 任务 3：管家换 harness 与模型

1. **`GET /api/steward/runtime-choices`**，列出组合：
   - **native**：每个已配置模型都是一个选项（`provider` 协议须是 native 支持的），`harness: 'native'`，`harnessLabel: '内置（直连模型 API）'`；
   - **外部 harness**：声明了 `capabilities.mcp` 的（claude-code、codex 等）。
     - 能 `customProvider` 的，与协议匹配的模型逐个组合（复用 `providerFor` / `providerProtocols` 的判断，不要另写一套）；
     - 不能的，只给一个"harness 自带模型"的选项（`model` 为空）。
   - `available: false` 时，`reason` 写人话：harness 未安装、缺密钥环境变量、协议不匹配。
   - `isDefault` 标出当前默认：会话没指定时用偏好 `prefs.harness`，再退到默认空间的 `steward.harness`。
   - 多空间时以默认空间（`prefs.defaultSpace`）的配置为准，同名模型不重复列。
2. **会话固定**：
   - `PATCH runtime` 校验组合存在且可用，不可用 400 并给原因；
   - 回复时按"会话 runtime > 偏好 > 空间默认"选。
3. **native 路径**：沿用现有 `configuredChat`，只是模型来自会话的选择。

## 任务 4：外部 harness 跑管家（MCP 桥）

1. **`POST /api/steward/mcp`**（streamable HTTP 的最小子集）：
   - 方法：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`；
   - `tools/list` 从 `StewardTools.specs()` 转换；
   - `tools/call` 执行同一套管家工具，结果写成 MCP 的 `content: [{ type: 'text', text }]`；
   - 鉴权：每轮回复签发一个随机令牌，只在本轮有效，绑定用户和会话；回复结束即作废；`Authorization: Bearer <token>`；
   - 只接受来自 127.0.0.1 的请求。
2. **一轮回复**：
   - 用 `createHarness`（或现有注册表）拿到 harness，`run` 时传：
     - `prompt`：会话历史压缩成文本加本轮问题；
     - `systemAppend`：管家系统提示；
     - `mcpServers: [{ name: 'takt', url, headers: { Authorization } }]`；
     - `readOnly: true`：管家本身只读，写操作走提案；
     - `cwd`：默认空间根目录。
   - 事件映射：
     - harness 的 `message`（assistant）流式转成 `StewardStreamEvent` 的增量；
     - 工具调用转成 `StewardToolCall`（`tool` 去掉 `mcp__takt__` 前缀）；
     - 最终文本作为消息正文；
     - 提案、实体块等由工具结果产生，和 native 路径一致。
3. **harness 适配**：
   - claude-code：
     - 有 `mcpServers` 时加 `--mcp-config <临时 JSON 文件>`（`{ mcpServers: { takt: { type: 'http', url, headers } } }`）和 `--strict-mcp-config`；
     - 只放行 takt 的工具：`--allowedTools mcp__takt__*`，并禁用内置的写文件和 Bash；
     - 临时文件放系统临时目录，结束删除。
   - codex：用 `-c mcp_servers.takt.url=...`，令牌走 `bearer_token_env_var` 指向一个只在子进程 env 里的变量。
   - 其他声明 `mcp` 的 harness 先不接，`runtime-choices` 里不列。
4. **失败处理**：harness 不可用或运行失败时写会话 `status: 'error'` 与原因，不自动换 harness（用户自己选）。

## 测试

- 会话 PATCH / DELETE / 列表排序 / 归档过滤 / 409，状态流转（含启动时 replying → interrupted），归属推断。
- digest 去重与 `more`。
- runtime-choices：用 mock 配置覆盖可用、缺密钥、协议不匹配三种情况。
- MCP：
  - 令牌校验（无令牌、过期令牌、别人的令牌）；
  - `tools/list` 与 `tools/call` 往返；
  - 用 mock harness 跑一轮，断言 `mcpServers` 传到了、工具调用和文本映射正确；
  - claude-code 适配器在有 `mcpServers` 时的参数（单测，不起真进程）。

## 交付说明

中文，写清：
- 做了什么（按任务编号）；
- 没做什么；
- 已知问题；
- 协议变更请求（如有）；
- 新增 / 修改的文件清单。
