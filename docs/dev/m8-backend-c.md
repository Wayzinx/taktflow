# 开发简报：M8 后端 C（角色结构化读写、自动化与 IM 通知；docs/design/30 §3、§4）

**先读**：`AGENTS.md`、`docs/design/30-打磨一致性会话与自动化.md`（§3、§4）、`docs/design/14`（项目空间）、`docs/design/27 §4`（模型与 Harness 配置的写回方式）。

**协议已经加好**，不要改 `packages/core/src/{types,interfaces,api}.ts`；确需改动写进交付说明的"协议变更请求"。本轮新增：
- api.ts 路由表"角色与自动化"一节：`/api/space/agents*`、`/api/space/automations*`、`/api/space/channels*`；
- api.ts：`SettingSource`、`AgentRoleView`、`AgentRoleWrite`、`AutomationsView`、`AutomationView`、`ChannelView`、`AutomationRunRecord`、`AutomationDelivery`；
- types.ts：`AgentProfile.knowledge`，`TaktConfig.automations` / `channels`，`AutomationEvent`、`AutomationTrigger`、`AutomationAction`、`AutomationConfig`、`ChannelConfig`。

多空间 serve 下这些路由同样挂在 `/api/s/:space/...`，和现有空间接口一致。

**通用要求**：
- 错误信息用中文并说明下一步；测试里不调用付费模型，不发真实网络请求（渠道发送用可注入的 `fetch`）；
- 写操作只允许 owner，带 `reason`，记进空间事件（沿用现有配置写回与修订记录的做法，不要另起一套）；
- 完成前跑 `npm run demo`、`npm run demo:standard`、`npm run demo:steward`，都不能变红。

**负责范围**：`packages/core/src/`（角色加载、知识库按角色过滤、自动化执行器）、`packages/server/src/`（路由、调度器接线）、相应测试。**不要动 `packages/web/`**，前端同时在改。

---

## 任务 1：角色结构化读写

1. **GET `/api/space/agents`、`/api/space/agents/:role`**：
   - 来源合并：空间档案（`paths.agents`，默认 `agents/` 或旧项目的 `.takt/agents/`）> 插件 `roles` > 内置；`origin` 标出来源；
   - `effective`：档案写了 `harness` → `source: 'role'`；否则 `config.roles[role]` → `'space-default'`；否则内置默认 → `'builtin'`。复用引擎里现有的选择逻辑，不要另写一套，保证界面显示的和真正跑的一致；
   - `usedBy`：扫描已注册的 workflow，列出 `role` 等于它的节点；节点自己写了 `harness` 的把它放进 `harness`；
   - `problems`：引用了不存在的技能、知识库、模型别名，或 harness 未注册。
2. **PUT `/api/space/agents/:role`**：
   - 只改 frontmatter 里给了的字段，`null` 删除该字段；正文只有给了 `instructions` 才替换；
   - frontmatter 的其他字段、键的顺序、正文原样保留（用现有 frontmatter 解析 / 序列化工具；写回后再解析一次，必须与写入值一致）；
   - `baseRevision` 不一致 409："角色档案已被其他人修改，请刷新后重试"；
   - 插件 / 内置角色第一次保存时在空间档案目录里新建一份（含原正文），之后 `origin` 变为 `space`；
   - `role` 只允许 `[a-z][a-z0-9-]{0,39}`；`writeScope` / `readScope` 必须是相对路径 glob，不能以 `/` 开头或含 `..`；
   - 校验：`harness.harness` 已注册、`model` 是已配置的别名或 harness 认识的原名、`skills` 存在、`knowledge` 是已绑定的知识库，不满足 400 并指出字段。
3. **DELETE `/api/space/agents/:role`**：只能删空间档案；还有 workflow 节点用它时 409，并列出 `workflow/节点`。
4. **按角色过滤知识库**：节点没写 `knowledge.bases` 时，用角色档案的 `knowledge`；都没写才是空间绑定的全部。优先级 节点 > 角色 > 空间，加单测覆盖三层。
5. 现有 `/api/space/files?kind=agent` 保持可用（"切到源码"还在用），两边写的是同一个文件。

## 任务 2：自动化与通知渠道

1. **配置读写**：
   - `automations[]` / `channels[]` 存在 `takt.config.json`，PUT / DELETE 走现有配置写回（原子写、修订记录、写后热加载，不重启 serve）；
   - `id` 只允许 `[a-z0-9][a-z0-9-]{0,39}`；
   - 校验：cron 必须是 5 段且每段合法；`start_workflow.workflowId` 已注册；定时触发的 `start_workflow` 必须有 `requirementId`；`digest` / `notify` 至少一个渠道；渠道 id 存在；
   - `GET /api/space/automations` 返回 `AutomationsView`：
     - `nextAt` 按本机时区算；
     - `lastRun` 取最近一条记录；
     - `problems` 列出引用失效（被删的渠道 / workflow / 需求、渠道地址缺失）；
     - `ChannelView.url` / `secret` 用现有的密钥来源判断（env > 本机密钥库 > missing），不返回值。
2. **调度器**（server，每个空间一个，随空间加载 / 卸载启停）：
   - **定时**：自己实现 5 段 cron 的解析与"下一次时间"（`*`、数字、`a-b`、`*/n`、`a,b`，周 0–7 都表示周日），不引新依赖；每分钟对齐检查一次；
     - serve 停机期间错过的不补跑；
     - 同一自动化上一轮还没结束就跳过本轮，记一条 `skipped`。
   - **事件**：订阅运行事件总线：
     - `run.finished` 是运行以 `succeeded` 结束；`run.failed` 是 `failed`；
     - `requirement.created` 是新建需求；
     - `attention.overdue` 是等人超过时限（沿用 docs/design/26 §3 的时限判断，同一个待办只触发一次）。
     - `filter` 按 workflow / 需求过滤。
   - **防循环**：`start_workflow` 启动的运行结束时不再触发 `start_workflow` 类的自动化（通知类照常）。
3. **动作**：
   - `start_workflow`：
     - 用现有命令（`run.start`）启动，代表人写 `automation:<id>`（作为 Actor，沿用现有 actor 类型，确需新增写进协议变更请求）；
     - 记录 `runId`；需求不存在或已有运行在跑时 `skipped` 并写原因。
   - `digest`：
     - 用管家 digest 同一份生成逻辑（按需求去重，见 B 批任务 2），范围限本空间；
     - 渲染成纯文本，每个需求一行：标题、最新进展、状态，附链接；
     - 末尾是等人的事和失败的运行；
     - 没有任何变化时 `skipped`，不发空消息。
   - `notify`：渲染 `text` 里的占位符；没有事件上下文的占位符留空。
   - **链接**：基址取 `TAKT_PUBLIC_URL` 环境变量，没有就用 serve 的地址；链接到需求页 `/req/:id`、运行页 `/run/:runId`（多空间加 `/s/:space` 前缀，和前端路由一致）。
4. **渠道发送**（`packages/core` 或 server 里一个 `sendToChannel(channel, message, fetch)`）：
   - **飞书 / Lark**：
     - `{ msg_type: 'text', content: { text } }`；
     - 有 `secretEnv` 时按飞书签名规则带 `timestamp` 与 `sign`（HmacSHA256，key 为 `timestamp + "\n" + secret`，对空串签名，Base64）；
     - 响应 `code !== 0` 视为失败并带上 `msg`。
   - **Slack**：`{ text }`。
   - **Webhook**：`{ automation: { id, title }, event, text, links }`，有 `secretEnv` 时加 `X-Takt-Signature: sha256=<hex(hmac(body))>`。
   - **通用**：超时 10 秒；失败重试 1 次（间隔 2 秒）；每个渠道各自记 `AutomationDelivery`；错误信息里不能出现地址和密钥（用现有 redactor）。
5. **执行记录**：
   - 存 `.takt/automations/runs.jsonl`（只追加），每个自动化保留最近 200 条，超过的在写入时裁掉；
   - `GET .../runs` 返回最近 20 条；
   - 执行开始写 `running`，结束写终态；serve 重启时残留的 `running` 改成 `failed`（"serve 重启，执行中断"）；
   - 自动化被删后它的记录保留，列表里不再出现。
6. **手动触发与重试**：
   - `trigger`：立即执行一次，`trigger: 'manual'`，有事件依赖的占位符留空；
   - `retry`：只允许 `failed` 的记录，按原 `event` 重跑，写 `retryOf`。
7. **渠道测试**：`POST /api/space/channels/:id/test` 发一条"takt 渠道测试：<空间名>"，返回 `AutomationDelivery`，不写执行记录。

## 测试

- 角色：
  - 三层生效值与来源；
  - PUT 只改给了的字段、正文与其他字段原样保留；
  - `null` 删除字段；409；插件角色首次保存落盘；
  - 校验 400；DELETE 被引用时 409；
  - 知识库按角色过滤。
- cron：
  - 解析与下一次时间（含 `*/15`、`1-5`、周 7）；
  - 非法表达式报错指出哪一段。
- 调度：
  - 用假时钟，到点触发一次；上一轮未结束时 `skipped`；
  - 停机错过不补跑。
- 事件触发：
  - `run.failed` 带 filter；
  - `attention.overdue` 只触发一次；
  - `start_workflow` 不被自己启动的运行再次触发。
- 动作：
  - `start_workflow` 启动与"已有运行在跑"跳过；
  - `digest` 去重、无变化跳过；
  - `notify` 占位符。
- 渠道：
  - 三种渠道的请求体，飞书签名对照固定时间戳的期望值；
  - 失败重试一次；
  - 错误信息不含地址 / 密钥。
- 记录：
  - 裁剪到 200；
  - 重启时 `running` → `failed`；
  - `retry` 只允许 `failed`。

## 交付说明

中文，写清：
- 做了什么（按任务编号）；
- 没做什么；
- 已知问题；
- 协议变更请求（如有）；
- 新增 / 修改的文件清单。
