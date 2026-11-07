# 开发简报：M4 后端（管家、增删改、知识库；docs/design/22、23）

**先读**：`AGENTS.md`、`docs/design/22-管家与操作体验.md`、`docs/design/23-知识库体系.md`，以及你负责的那一节。

**协议已经加好**，不要改 `packages/core/src/{types,interfaces,api}.ts`。确需改动，写进交付说明的"协议变更请求"。本轮新增的协议要点：

- **types.ts**
  - 需求与配置：
    - `Requirement.description / dueAt / archivedAt`；
    - `TaktConfig.project.color / knowledgeBindings / knowledgeDefaults / steward`；
    - `ModelConfig.kind / dimensions`。
  - 知识查询：
    - `AgentNodeDef.knowledge` 可以是 `KnowledgeQuery[]`，也可以是 `KnowledgeNodeSpec`；
    - `KnowledgeQuery.bases`；
    - `KnowledgeHit.baseId / version / rank / scores`；
    - `knowledge.query` 事件新增字段；新增 `knowledge.used` 事件。
  - 知识库：`KnowledgeBase / KnowledgeRetrieval / KnowledgeBinding / KnowledgeBuild(Stage) / KnowledgeEvalCase / KnowledgeEvalMetrics / KnowledgeEvalVariant / KnowledgeEvalRun / KnowledgeMissDiagnosis`。
- **interfaces.ts**：`SecretResolver`、`KnowledgeKind(Context)`、`KnowledgeBuildProgress`、`KnowledgeStore`、`ProjectStores.kb`。
- **api.ts**
  - 路由表新增三节：增删改、管家、知识库。
  - 增删改的 DTO：`ServerInfo`、`RequirementCreate/Update*`、`SpaceCreate/UpdateRequest`、`SpaceTemplate`、`WorkflowConvertResult`；`SpaceSummary` 新增 `color / archived / archivedAt / risks / pendingAttention / lastActivityAt`。
  - 管家的 DTO：`Steward*`、`Proposal(Step) / ProposalDecisionRequest`、`Risk* / Digest / StewardFeedItem / StewardPrefs`、`ProductEvent / ProductMetric`。
  - 知识库的 DTO：`Knowledge*` 系列。

**任务批次**：

- 第一批三个任务并行：m4-crud、m4-steward、m4-kb，**负责范围互不重叠**。
- 第二批：m4-kb-eval，然后 m4-integrate（接线、演示、全量验收）。

各任务只跑自己范围的测试，外加 `npm run demo`。

**通用要求**：

- 写操作都要求 `reason`，并记审计：空间级写入用 `auditSpace`，配置修改用 `changeConfig`，两者都在 server 的 space.ts 里。
- 所有路径参数都要防目录穿越。
- 错误信息用中文，并说明下一步怎么做。

---

## 任务 m4-crud（需求与空间的增删改、workflow 转换）

**负责范围**：

- **core**：
  - `packages/core/src/store/` 中需求读写相关的文件：新字段的持久化、归档与删除；
  - `packages/core/src/commands/{schema,index}.ts`；
  - 新建 `packages/core/src/commands/crud-commands.ts`。
- **server**：
  - 新建 `packages/server/src/{crud-routes,space-admin}.ts`；
  - 修改 `packages/server/src/{space,read-model,workflow-routes,router,routes}.ts`。本任务在 router / routes 里只注册自己的路由。
- **workflow-source**：新建 `packages/workflow-source/src/convert.ts`，并加导出。
- **cli**：`packages/cli/src/commands/{req,space,init}.ts`，以及 `packages/cli/src/index.ts` 里这些子命令的注册。
- **examples**：`examples/standard-delivery/{demo-chat,demo-quick}.ts`。
- 以上文件的测试。

**不要碰**：`packages/core/src/{steward,knowledge,insights}/**`、`packages/knowledge/**`、`packages/core/src/engine/**`。

1. **新建需求**（`POST /api/requirements`，与命令 `requirement.create` 共用同一个实现 `createRequirementFull`）：
   - `requirement.create` 的 schema 扩展为 `RequirementCreateRequest` 的全部字段。
   - 创建需求，持久化 `description / owner / members / links / dueAt`。
   - 描述写进存放区的 `inputs/prd.md`（kind `input`，作者为当前用户）。
   - 附件写进 `inputs/<安全文件名>`：
     - 文件名只保留 `[\w.\-一-龥]`；
     - 单个文件不超过 5MB，总量不超过 20MB；
     - base64 解码后写入。
   - 没有给 `workflowId` 时，用现有的路由预览（description 作为 hint）选出流程。
   - `start !== false` 时启动运行，参数为 `route / budget / repos`。
     - 启动失败不回滚需求，原因写进 `startError`。
     - 必需输入已经写好，所以 standard 流程不应该再报"缺少必需输入"。
   - 返回 `RequirementCreateResponse`。
2. **编辑、归档、恢复、删除**：
   - **编辑**：`PATCH` 编辑字段，`dueAt: null` 表示清除；记审计。
   - **归档**：
     - 需求有 `running` 或 `waiting_human` 的运行时返回 409，提示"先取消运行"；
     - 归档写 `status: 'archived'` 和 `archivedAt`；
     - `GET /api/requirements` 和总览默认不包含已归档的需求，`?archived=1` 时包含。
   - **恢复**：清空 `archivedAt`，按运行记录重新推导状态。
   - **删除**：只允许删除没有任何运行记录的需求，否则返回 409。删除时一并删除存放区目录、群聊、待办里属于该需求的数据。
3. **空间**（`space-admin.ts`）：
   - **新建**：只在多空间模式（`serve --spaces <根>`）下可用。
     - 校验 id 正则；id 不能和活动空间、`.archive` 里的空间重复。
     - 名称去空白、忽略大小写后，不能和活动空间重复。违反以上任一条返回 409，并给出原因。
     - 起点模板：
       - `blank`：只有配置文件和目录骨架；
       - `standard`：角色、`taktflow-standard`、`quick-fix`；
       - `quick`：只有 `quick-fix` 和需要的角色。
       - 把 cli `init.ts` 里复制模板的逻辑移到 server 的 `initSpace(dir, template)`，cli 改为调用它。
     - `copyFrom` 时，按 `parts` 从源空间复制：
       - `agents/`、`skills/`；
       - `workflows/`，同时同步 `config.workflows`；
       - `knowledge/`，同时同步 `knowledgeBindings`；
       - `models / providers / roles / harnesses` 这几个配置键；
       - `members`。
     - 成员：请求里没给成员时，当前用户（`x-takt-user`）为 owner。
     - 仓库：本地路径必须存在；git URL 只登记绑定，由现有的同步机制克隆。
     - 新空间不重启就能被服务发现，切换器里立即可见。
   - **修改**：`PATCH` 改名称、描述、颜色；名称唯一性规则同上。
   - **归档**：
     - 有运行中的需求时拒绝；
     - 把目录移到 `<根>/.archive/<id>@<YYYYMMDD-HHmmss>/`，并从服务中摘除。
     - `GET /api/spaces?archived=1` 返回已归档的空间，`id` 为 `<id>@<时间>`，`archived: true`。
   - **恢复**：把目录移回原 id；原 id 已被占用时返回 409。
   - **删除**：只允许删除已归档的空间，`confirm` 必须等于 id。
   - **审计**：空间级操作记到 `<根>/.takt/space-admin.jsonl`，写法同 space-events，用哈希链。
   - **发现**：`discoverSpaces` 跳过所有以点开头的目录（`.archive`、`.shared`、`.steward`、`.takt`）。
   - **服务端命令表**：导出 `createServerCommandRegistry(deps)`。
     - 接口和 `CommandRegistry` 相同，命令为 `space.create / space.update / space.archive / space.restore`。
     - 供管家执行"不属于任何空间"的提案步骤。
   - **`SpaceSummary` 补字段**：
     - `color`；
     - `pendingAttention`；
     - `lastActivityAt`：取需求的 `updatedAt` 和运行最近事件中最新的时间；
     - `risks` 留给 m4-integrate。
   - **`GET /api/server`** 返回 `ServerInfo`：
     - `steward` 先返回 `{ configured: false, reason: '管家尚未接入' }`，由 m4-integrate 补全；
     - 单空间模式下，`multiSpaceHint` 给出用上级目录启动的完整命令。
4. **workflow 转换**（`convert.ts`）：`convertWorkflowSource(source)` 返回 `{ ok, source?, reason? }`。
   - 支持两种写法：
     - `export default { ... }` 对象字面量；
     - `const x = {...}; export default x`。
   - 两种都改写为 `export default defineWorkflow({...})`，并在 `@taktflow/core` 的 import 里补上 `defineWorkflow`；没有这条 import 就新建。其他 import 和注释保持不变。
   - 已经是 `defineWorkflow` 写法的，返回 `ok: false`，原因写"已是可编辑写法"。
   - 改写后必须能被现有的 `parse` 解析通过，否则返回 `ok: false` 并附上诊断。
   - 路由 `POST /api/workflows/:id/convert`：
     - `dryRun` 时返回 `source + diff`；
     - 否则用 workflow store 的源码写入（带 baseRev、修订和审计），返回 `document`。
5. **新命令**（`crud-commands.ts`，导出 `crudCommandSpecs(deps)`，形状与 eval-commands 一致；由本任务注册进命令表）：
   - `requirement.update`、`requirement.archive`、`requirement.restore`：`write`。
   - `workflow.edit`：输入 `workflowId, baseRev, edits`，走 workflow store 的 edit；`write`，`maintainer`。
   - `workflow.convert`：输入 `workflowId`；`write`，`maintainer`。
   - `file.write`：写空间内文件。
     - 输入 `path, content, baseHash?`；
     - 只允许写 `agents/**`、`skills/**`、`knowledge/**/*.{md,json}`、`workflows/*.layout.json`；
     - `baseHash` 不一致时报错；
     - 原子写入，并记审计；
     - 风险级别 `write`，`maintainer`。
   - `config.patch`：输入 `patch`，对配置做 JSON merge patch。
     - 只允许这些键：`project`（name / description / color）、`members`、`repos`、`roles`、`models`、`providers`、`budget`、`lead`、`route`、`retry`、`lessons`、`steward`、`knowledgeDefaults`、`contextBudgetTokens`、`sandbox`；
     - 结果复用现有的 `members()` / `repoBinding()` 做校验；
     - 风险级别 `write`，`maintainer`。
6. **CLI**：
   - `takt req new` 增加选项：`--desc`、`--desc-file`、`--workflow`、`--start`、`--due`；
   - 新增 `takt req edit <REQ> [--title] [--desc] [--due] [--owner]`、`takt req archive|restore|rm <REQ>`；
   - 新增 `takt space new <id> --name <名称> [--template blank|standard|quick] [--from <空间> --parts a,b] [--color]`，需要 `--spaces`；
   - 新增 `takt space archive|restore|rm <id>`、`takt workflow convert <id> [--dry-run]`。
7. **示例修复**：
   - `demo-chat.ts` 生成的 `chat-auto.workflow.ts` 改用 `defineWorkflow` 写法；
   - `demo-quick.ts` 的项目名改为"快速修复示例"，避免与 standard 同名。
8. **测试**：覆盖以下场景。
   - 新建需求：带附件、自动路由、启动成功、启动失败；
   - 归档冲突和删除冲突；
   - 空间：新建（三种模板加 copyFrom）、id / 名称冲突、归档 / 恢复 / 删除、发现时跳过点目录；
   - 转换：三种输入写法；
   - 新命令的权限和审计。

**完成定义**：

- `npx tsc -b packages/core packages/server packages/cli packages/workflow-source`；
- `npx vitest run packages/core/src/store packages/core/src/commands packages/server packages/cli packages/workflow-source`；
- `npm run demo`、`npm run demo:chat`、`npm run demo:quick`；
- 把 `examples` 复制到 `/tmp/takt-m4-crud`，后台启动 `npm run takt -- serve --spaces /tmp/takt-m4-crud --port 4881`，然后用 curl 依次验证：
  1. `/api/server`；
  2. `POST /api/spaces` 新建空间；
  3. 在新空间里 `POST /api/s/<新空间>/requirements`，带 `start: false`；
  4. 归档并恢复这个空间；
  5. `POST /api/s/chat-demo/workflows/chat-auto/convert` 用 `dryRun`。
  
  检查完关闭该进程。

---

## 任务 m4-steward（管家）

**负责范围**：

- 新建 `packages/core/src/steward/**`；
- 新建 `packages/core/src/insights/risks.ts`；
- 新建 `packages/server/src/steward-routes.ts`，导出 `registerStewardRoutes(router, deps)`；
- 新建 `packages/cli/src/commands/steward.ts`，导出 `runStewardCommand(cli)`；
- 新建 `templates/agents/steward.md`；
- 以上文件的测试。

**不要碰**：`router.ts`、`routes.ts`、`cli/src/index.ts`，这些由 m4-integrate 接线。`packages/core/src/index.ts` 只能追加导出行。

1. **依赖抽象**（`steward/contracts.ts`）：管家跨空间工作，不直接依赖 server，由 steward-routes 注入以下内容。

   ```ts
   interface StewardSpace {
     id: string; name: string; dir: string
     stores: ProjectStores
     commands: CommandRegistry
     workflows: { get(id: string): Promise<WorkflowDocument>; rollback(id: string, rev: string, by: Actor, reason: string): Promise<unknown> }
     /** 以管家身份在需求群发消息并 @lead；返回群消息 id。 */
     postToLead(requirementId: string, text: string): Promise<string>
     /** 订阅群聊新消息（等 Lead 回复）。 */
     onChat(requirementId: string, listener: (m: RoomMessage) => void): () => void
   }
   interface StewardDeps {
     dataDir(userId: string): string               // <根>/.steward/<user>/；单空间模式为 <项目>/.takt/steward/<user>/
     spaces(): Promise<SpaceSummary[]>
     open(spaceId: string): Promise<StewardSpace>
     serverCommands?: CommandRegistry              // space.* 等不属于任何空间的命令
     chat?: (req: ChatRequest) => Promise<ChatResponse>   // 没配模型时缺省 → 规则降级
     onToken?: ...                                  // 流式输出：provider 支持就逐段推，不支持就整段
     now?: () => Date
     extraRisks?: (space: StewardSpace) => Promise<Risk[]>   // 知识库等扩展风险（m4-kb-eval 提供）
   }
   ```

2. **存储**（`steward/store.ts`）：放在 `dataDir(user)` 下，内容如下。
   - `threads/<id>.json`：元数据；
   - `threads/<id>.jsonl`：消息，追加写；
   - `proposals/<id>.json`；
   - `risks.json`：按 key 存状态；
   - `prefs.json`：缺省值为 `{ trust: 'confirm', digestTimes: ['09:30', '18:00'] }`；
   - `profile.md`；
   - `feed.jsonl`；
   - `metrics.jsonl`；
   - `seen.json`：上次查看汇报的时间。

   所有写入都用原子写；同一个用户的写操作串行执行。
3. **工具**（`steward/tools.ts`）：每个工具都带 JSON schema（用于函数调用），返回 `{ data, citations, summary }`。

   **只读工具**：
   - `list_spaces`、`space_overview`、`list_requirements(spaceId, status?)`；
   - `requirement_status`：阶段、当前节点、待办、预算、最近运行、档位；
   - `run_status`、`list_attention(spaceId?)`、`list_risks(spaceId?)`、`get_metrics`；
   - `workflow_get`：可编辑模型、诊断、当前 rev；
   - `knowledge_search`：只在 `stores.kb` 存在时提供；
   - `get_config`：密钥一律打码；
   - `eval_scorecards`、`list_commands`；
   - `read_file`：只能读空间目录内的文件；禁止读 `.takt/**` 和 `*.secret*`；单次最多 64KB。

   **citations 的 href**：统一由 `steward/links.ts` 生成。路由和 web 一致，空间内的路由都加 `/s/<space>` 前缀：
   - 总览 `/s/<space>`；
   - 需求 `/s/<space>/req/<id>`，Tab 用 `?tab=`；
   - 运行 `/s/<space>/run/<runId>`，节点用 `?node=<id>`；
   - workflow `/s/<space>/workflows/<id>`；
   - 知识库 `/s/<space>/knowledge/<id>`；
   - 设置 `/s/<space>/settings?tab=<tab>`；
   - 待办 `/s/<space>/attention`；
   - 全局管家页 `/steward`，空间列表页 `/spaces`。

   **写工具**：只有 `propose(title, summary, steps)` 一个，生成提案，不直接执行（见第 5 点）。

   **转达工具**：`ask_lead(spaceId, requirementId, message)`。
   - 发群消息，最多等 60 秒 Lead 的回复。
   - 超时就返回"已转达"；之后回复到达时，再异步更新该条 `StewardDelegation`，并推送 feed。
4. **对话**（`steward/agent.ts`）：
   - **system prompt** 依次由这几部分组成：`templates/agents/steward.md`、`profile.md`、偏好、上下文引用的简要解析（空间名、需求标题、workflow 名）、当前时间。
   - **工具循环**：
     - 最多 8 轮；
     - 每次工具调用都推送 `tool` 事件；正文按 `delta` 推送。
   - **引用**：工具返回的 citations 统一编号。正文里只保留有效的 `[n]`，其余删除；没有被引用的 citation 也从列表里删除。
   - **出提案时**：消息带上 `proposalIds`，并推送 `proposal` 事件。
   - **后续建议**：结尾最多给 3 条。
   - **会话标题**：取第一条用户消息的前 20 个字。
   - **规则降级**（`steward/offline.ts`，没有 `chat` 时使用）。按中文和英文关键词识别以下意图：
     - 进度：针对上下文里的空间 / 需求，没有就针对关注的空间；
     - 风险、待办：用工具结果生成带引用的回答；
     - "新建 / 建个 / 创建需求 <标题>"：提案 `requirement.create`，空间取当前或默认空间；
     - "新建空间 <名称>"：提案 `space.create`，模板 `standard`，id 由名称生成；
     - 其他：回复"需要先配置管家模型"，并给出设置链接；消息标记 `offline: true`。
5. **提案**（`steward/proposals.ts`）：
   - **校验**：
     - command 步骤：命令要存在于目标命令表（有 `spaceId` 用空间表，否则用 `serverCommands`），输入要符合 schema；
     - workflow 步骤：在内存里对当前文档套用 edits，必须成功；
     - file 步骤：只能用 `file.write` 允许的路径。
   - **hash**：步骤规范化 JSON（键排序）后的 sha256。
   - **预览**：
     - workflow 步骤：编辑前后源码的统一 diff；
     - file 步骤：统一 diff；
     - command 步骤：参数的人话摘要。
   - **风险**：取所有步骤的最高值。
     - `dangerous` 命令为 high；
     - `requirement.create / requirement.update / knowledge.create / knowledge.update`，以及 file 步骤写 `profile.md`，为 low；
     - 其余为 medium。
   - **approve**：
     - `hash` 不一致返回 409；
     - 带了 `steps` 时重新校验，标记 `edited`，重算 hash；
     - workflow 的 `baseRev` 或 file 的 `baseHash` 与当前不一致时，状态改为 `stale` 并返回 409。
   - **执行**：逐步执行，执行者是批准人，原因为 `管家提案 <id>：<title>`。
     - 某一步失败时，倒序撤销已成功的步骤，状态改为 `failed`。
     - 撤销方式：
       - `requirement.create` → `requirement.archive`；
       - `space.create` → `space.archive`；
       - workflow 步骤 → 回滚到执行前的 rev；
       - `config.patch` → 用执行前的快照算出逆 patch；
       - `file.write` → 写回原内容；
       - `knowledge.create` → 删除。
     - 全部成功时状态为 `applied`，`undoUntil` 设为 24 小时后。
   - **undo**：只在 `undoUntil` 之前可用，并且目标自执行后没被改过（workflow 的 rev 等于执行后的 rev，文件 hash 等于写入的 hash）。成功后状态为 `reverted`。
   - **自动执行**：信任档位为 `auto-low`、提案风险为 `low`、并且每一步都能撤销时，直接执行，标记 `auto: true`。
6. **风险**：
   - **计算**（`insights/risks.ts`）：纯函数，签名为 `computeRisks(stores, spaceId, now, thresholds?) → Risk[]`，返回的风险不带 state 字段。阈值按设计文档 22 §1.6 的表格。
   - **合并**（`steward/risks.ts`）：
     - 把计算结果和 `extraRisks` 与已存状态合并：`firstSeenAt` 保留首次出现时间；已不存在的风险标为 `resolved`。
     - `snoozed` 到期后恢复为 `open`。
     - 以下三种情况产生 feed，并更新 `notifiedLevel`：
       - 新风险；
       - 级别升高；
       - 距上次提醒超过 24 小时且仍未解决。
     - 静音的空间和免打扰时段内不推送，但照样记录。
7. **汇报**（`steward/digest.ts`）：
   - **内容**：从上次查看（或指定的 `since`）到现在，在关注的空间里（排除静音空间），由规则生成以下列表：
     - 待办：附等待时长；
     - 新风险；
     - 进展：新建、启动、阶段推进、交付、失败、阻塞；
     - 指标变化。
   - **摘要**：有模型时让模型写两句；没有模型时由规则拼一句。
   - **调度**：每分钟检查一次；工作日到了 `digestTimes` 中的时间点，就生成一份汇报写进 feed 并推送 SSE。查看 `GET /api/steward/digest` 时更新 `seen.json`。
8. **建议**（`steward/suggestions.ts`）：按 `page` 参数生成，最多 3 条，由规则产生，并带上具体对象名。页面包括：overview / requirements / requirement / run / workflow / knowledge / settings-<tab> / eval / spaces。例如：
   - 需求在等人回答时："帮我看看 REQ-002 卡在哪"；
   - workflow 页："在 test 之后加一个交叉评审"；
   - 还没有知识库时："帮我从 docs/ 建一个文档知识库"。
9. **度量**（`steward/metrics.ts`）：
   - **记录**：
     - 回答：首字延迟、工具调用数、引用覆盖率（带 `[n]` 的句子 / 含数字或状态词的句子）；
     - 反馈；
     - 提案决定：通过、改后通过、拒绝、撤销、失败，并按命令分类；
     - `POST /api/steward/events` 上报的页面事件。
   - **统计**：`GET /api/steward/metrics` 汇总成 `ProductMetric[]`，覆盖设计文档 22 §5 表格里的功能，窗口 7 天，按天给出趋势，并给出 `hint`。
     - 需求新建漏斗的数据来自页面事件和需求事件；
     - 路由改写率来自 `route.decided` 的 `overridden`。
10. **路由**：实现 api.ts 管家一节的全部路由。
    - 线程流和全局 feed 都用 SSE；
    - 用户身份用 `x-takt-user`，和 `/api/me` 的取法一致；
    - steward-routes 里根据 server 现有的多空间注册表构造 `StewardDeps`。`chat` 先不接（m4-integrate 接）；`serverCommands` 用 m4-crud 的 `createServerCommandRegistry`。如果它还没写好，先通过参数注入。
11. **CLI**（`--spaces` 或 `--project`）：
    - `takt steward ask "<文本>" [--thread id] [--space id]`：打印回答、引用和提案；
    - `takt steward risks [--space]`、`takt steward digest`、`takt steward proposals`；
    - `takt steward approve|reject|undo <id>`。
12. **角色档案**（`templates/agents/steward.md`）应写明以下规则：
    - 只根据工具结果陈述事实，每句事实都要带 `[n]`；
    - 写操作一律通过 `propose`；
    - 需求内部的事用 `ask_lead`；
    - 一次只问一个澄清问题；
    - 回答先给结论，然后最多 5 个要点。
13. **测试**：用脚本化的假 chat 驱动，覆盖以下场景。
    - 问进度：回答带有效引用；
    - 提案的完整生命周期：创建 → 409（hash 不一致）→ 批准 → 执行 → 撤销；
    - workflow 提案在 rev 变化后变为 stale；
    - 多步提案中途失败时自动回滚；
    - `auto-low` 自动执行；
    - 风险规则的各个阈值，以及去重和升级；
    - 汇报：since 区间和静音；
    - 规则降级的四类意图；
    - 转达给 Lead：用假的 `postToLead` 和 `onChat`；
    - 路由权限：不同用户的数据互相隔离。

**完成定义**：

- `npx tsc -b packages/core packages/server packages/cli`；
- `npx vitest run packages/core/src/steward packages/core/src/insights packages/server/src/steward-routes.test.ts`；
- `npm run demo`。

---

## 任务 m4-kb（知识库：模型、类型、构建、检索、绑定、引擎接入）

**负责范围**：

- **knowledge 包**：
  - `packages/knowledge/src/**`，包括新建 `store/`、`kinds/`；
  - `eval/` 只建桩（见第 9 点）。
- **core**：
  - `packages/core/src/knowledge/**`；
  - `packages/core/src/engine/harness.ts` 里的知识部分；
  - `packages/core/src/engine/execution.ts` 里节点结束时检测引用的那一处；
  - 新建 `packages/core/src/commands/knowledge-commands.ts`。
- **server**：新建 `packages/server/src/knowledge-routes.ts`，导出 `registerKnowledgeRoutes(router, deps)`。
- **cli**：`packages/cli/src/commands/kb.ts`。
- **templates**：
  - `templates/workflows/kb-wiki-build.workflow.ts`；
  - `templates/agents/wiki-writer.md`。
- 以上文件的测试。

**不要碰**：`router.ts`、`routes.ts`、`cli/src/index.ts`，这些由 m4-integrate 接线。`packages/core/src/index.ts` 只能追加导出行。

1. **存储**（`store/`）：导出 `createKnowledgeStore(stores, opts)`，实现 `KnowledgeStore`。
   - `opts`：
     - `sharedRoot?`：没有时 `scope: 'shared'` 报错；
     - `secrets?`；
     - `embed?`、`chat?`；
     - `kinds?`：插件注册的额外类型。
   - **布局**：按设计文档 23"统一模型"一节。
   - **配置**：`kb.json` 按 kind 的 `configSchema` 校验，用 core 的 `validateSchema`。
   - **审计**：写操作记 space-events；`knowledgeBindings` 通过修改配置的现成函数写入，如果只有 server 才有这个函数，就在 core 里抽一个出来。
   - **版本**：
     - 每次构建写到 `v<n>/`，成功后设为 `candidateVersion`；
     - `publish` 把它设为 `version`，状态改为 `ready`；
     - 只保留最近 3 个版本的索引。
   - **构建任务**：
     - 后台执行，可以取消（AbortController）；
     - 进度写进 `builds/<id>.json`，日志保留最近 200 行，同时通知 `onBuild` 的订阅者；
     - 服务重启时，把仍处于 `running` 的构建标为 `failed`，原因写"服务重启中断"。
   - **过期**：构建清单记录每个源文件的哈希。查询详情时比对出 `staleDocs`；如果已发布版本里有源文件变了，状态改为 `stale`。
2. **密钥**（`store/secrets.ts`）：
   - `${env:NAME}` 从环境变量读取；
   - `secret:<name>` 从 `~/.takt/secrets.json` 读取，文件权限 0600，路径可以用 `TAKT_SECRETS_FILE` 覆盖；
   - `list` 只返回名字；
   - 配置里的密钥字段只能写引用，写明文要拒绝。
3. **类型**（`kinds/`），每个类型一个文件：
   - **`rag`**：
     - **数据源**：可以是 `upload`（`content/`）、`path`（空间内路径加 glob）、`repo`（绑定的仓库加 glob）、`url`（抓取一次，遵守网络策略）。
     - **解析**：
       - md：去掉 frontmatter，保留标题路径；
       - txt；
       - html：去掉标签，保留 title；
       - json；
       - csv：按行分组。
     - **切块**：先按标题切，再按大小切。默认 800 token，重叠 100。
     - **BM25**：自己实现。中文用字二元组，拉丁文用小写词；倒排表存成 JSON。
     - **向量**：有 `embed` 时启用，存成 Float32 二进制文件加元数据。增量构建时，块内容哈希没变的就复用旧向量。
     - **查询**：BM25 和向量各取 top 50，归一化后用加权 RRF（k=60）合并，再应用 `minScore` 和 `topK`。
       - hit 的 `ref` 为 `<文档路径>#<块序号>`，title 为标题路径；
       - `scores` 带上分项得分；
       - 检索测试时带上全文 `content`。
   - **`llm-wiki`**：
     - **来源**：`space`（`content/` 目录）、`path`（空间内目录）或 `git`（URL 加分支，克隆到 `.takt/knowledge/<id>/repo`）。
     - **构建**：从 `index.md` 的链接、标题和 frontmatter 的 `aliases` 生成导航索引，段落再建 BM25 索引。
     - **查询**：
       - 先找页标题和别名，精确匹配加权最高，子串匹配次之；
       - 再查段落；
       - hit 的 `ref` 为 `页面路径#锚点`。
     - **从代码仓库生成**（`config.generate: { repo, include, granularity }`）：
       - 构建时用临时任务运行机制（M2 的 task run）跑 `kb-wiki-build`：planner 按目录或模块拆分 → 每个单元一个 `wiki-writer` agent → 生成 index → review；
       - 产物放进 `v<n>/generated/`，`KnowledgeBuild.runId` 指向这次运行；
       - 发布时才把生成的页面写进 `content/`，并记审计。也就是说，发布就是人工批准。
   - **`database`**：
     - **驱动**：
       - `sqlite`：`node:sqlite`，用 readOnly 打开；
       - `postgres`：动态 import `pg`；
       - `mysql`：动态 import `mysql2/promise`。
       - 驱动不可用时，`available()` 返回原因，例如"需要安装 pg：npm i pg"。不要往 package.json 里加依赖。
     - **构建**：生成结构快照，包括表、列、类型、注释，以及可选的样例行。`config.notes` 里的口径说明合并进对应列，再建 BM25 索引。
     - **查询**：
       - 文本匹配 `^\s*(select|with|show|describe|explain)\b`（不区分大小写）时，作为 SQL 执行；否则做结构检索。
       - **只读守卫**：
         - 去掉注释；
         - 拒绝多语句；
         - 首个关键字必须在允许列表里；
         - 出现以下关键字一律拒绝：`insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|attach|pragma|into|for update`；
         - SELECT 和 WITH 语句没有 LIMIT 时，补上 `rowLimit`（默认 200）；
         - 只读事务加超时。
       - 结果每行生成一条 hit，`evidenceLevel: 'verified'`，带 `fetchedAt`。
       - 按 `mask` 对列打码：默认识别手机号、邮箱、身份证号。
       - 被拦截时通过 `KnowledgeQueryResponse.executed.blocked` 返回原因。
   - **`api`**：
     - **导入**：OpenAPI 3（JSON 或 YAML，可以用 core 依赖里的 yaml 包；如果 knowledge 包用不了，就只支持 JSON，并在交付说明里写明）。
     - **认证**：认证头用密钥引用。
     - **构建**：为每个操作建索引，字段包括 operationId、summary、description、路径和参数。
     - **查询**：
       - 文本匹配 `^(GET|POST|PUT|PATCH|DELETE)\s+/\S*` 时，作为调用执行。
         - 本期只放行 GET，并且必须在 allow 列表里；
         - 超时和 `maxBytes` 截断（默认 200KB）；
         - 认证头不写进事件。
       - 其他文本检索操作文档。
   - **`code`**：包装现有的 grep 源（加上 codegraph 桩），不需要构建，配置为 `{ repos? }`。
   - **`history`**：包装现有的 git-history 和 workspace 源，不需要构建。
4. **路由**（`store.route`）：
   - 从绑定中筛选：已启用、intent 匹配（绑定的 intents 优先于库自己的）、角色允许；`q.bases` 进一步限定范围。
   - 并行查询，每个库超时 8 秒；超时的库记进日志，然后跳过。
   - 跨库用 RRF 合并，同分时按绑定优先级排序。
   - 用 core 的 token 估算，按 `budgetTokens` 截断。
   - 每次查询（预取和工具调用都算）都追加一行到 `.takt/knowledge/queries.jsonl`，字段为：`queryId, at, runId?, nodeId?, requirementId?, role?, text, intent, bases, top, latencyMs, tokens, via`。
5. **引擎接入**：
   - `harness.ts`：
     - 有 `stores.kb` 时，用 `stores.kb.route(query, { role, bases: spec.bases })` 做预取。
     - 发出带新字段的 `knowledge.query` 事件，`via` 为 `'prefetch'`。
     - `mode` 为 `tool` 或 `both` 时，在 prompt 末尾加"知识库"一段：列出可用的库（id、名称、描述、intents），以及 `takt kb query "<问题>" --base <id>` 的用法。
     - 没有 `stores.kb` 时，保持旧逻辑不变。
   - `execution.ts`：节点结束时，从 `queries.jsonl` 和本次预取里找出属于该节点的查询。检查输出产物的内容是否包含命中的 ref；包含就发出 `knowledge.used` 事件，并在 `queries.jsonl` 里追加一行 `used`。
6. **迁移**：`POST /api/knowledge/migrate` 把旧的 `config.knowledge` 条目转成新知识库。
   - 对应关系：
     - `wiki` → `llm-wiki`，来源为 path；
     - `grep` → `code`；
     - `git-history` / `workspace` → `history`；
     - `database` / `api-registry` → `database` / `api` 的草稿。
   - `dryRun` 时只列出迁移结果；应用时写入 `kb.json` 和绑定，移除旧条目，并记审计。
7. **路由与命令**：
   - `knowledge-routes.ts` 实现 api.ts 知识库一节的全部路由。
     - 构建状态用 SSE 推送；
     - 上传和密钥路由都校验 `maintainer` 权限；
     - 详情里的 `usage`（`byNode`、`recent`、`trend`）和 `usage7d` 从 `queries.jsonl` 汇总，统计 7 天，按天给出趋势。
   - `knowledge-commands.ts`：
     - 写命令：`knowledge.create`、`knowledge.update`、`knowledge.build`、`knowledge.publish`、`knowledge.bind`；
     - 只读命令：`knowledge.query`、`knowledge.list`。
8. **CLI**（`kb.ts`）：
   - `takt kb ls`；
   - `takt kb new --kind --name [--config <json文件>]`；
   - `takt kb upload <id> <文件...>`；
   - `takt kb build <id> [--wait]`；
   - `takt kb query "<文本>" [--base id] [--intent] [--top]`：
     - 设置了环境变量 `TAKT_RUN_ID` / `TAKT_NODE_ID` 时记为 `via: 'tool'`；
     - 输出简洁、Agent 易读的文本；`--json` 时输出 JSON。
   - `takt kb publish <id> [--force --reason]`；
   - `takt kb bind <id> [--off]`；
   - `takt kb migrate [--dry-run]`；
   - `takt kb secret set <名字>`：从 stdin 读取值。
9. **评测桩**：`eval/index.ts` 导出以下函数，签名按 `KnowledgeStore` 里对应的方法，加上 `deps` 参数：
   - `synthesizeCases`、`harvestCases`、`runEval`、`publishGate`。

   本任务内的实现要求：
   - `publishGate` 先实现为：没有 active 用例时通过，原因写"无评测用例，首次发布"；有用例时也先放行，原因写"评测门槛尚未接入"。
   - 其余函数抛出"未实现（m4-kb-eval）"。
   - 评测集的存取（`evalSets` / `upsertCases`）由本任务实现。
10. **测试**：
    - rag：中英文混合语料的构建与查询；增量构建复用旧向量（用假的 `embed`）；BM25 对中文的检索。
    - llm-wiki：导航优先；生成流程可以只测 build 能创建一次 task run（用 mock harness）。
    - database：守卫的所有拒绝分支；打码；用 `node:sqlite` 测试，不可用时 `skip`。
    - api：用本地 http 起一个 OpenAPI 夹具，覆盖检索、GET 调用、非 GET 被拦截。
    - 其他：密钥；路由 RRF 和预算截断；迁移；版本保留；引擎预取；`knowledge.used` 检测。

**完成定义**：

- `npx tsc -b packages/core packages/knowledge packages/server packages/cli`；
- `npx vitest run packages/knowledge packages/core/src/knowledge packages/core/src/engine packages/core/src/commands`；
- `npm run demo`、`npm run demo:standard`。

---

## 任务 m4-kb-eval（第二批：召回评测与发布门槛）

**负责范围**：

- `packages/knowledge/src/eval/**`；
- 新建 `packages/knowledge/src/risks.ts`，导出 `knowledgeRisks(space)`，供管家的 `extraRisks` 使用；
- 测试。

1. **指标**：
   - Recall@5、Recall@10、Precision@5、MRR、nDCG@10（按 grade 分级计算）；
   - 命中率、无结果率、延迟 p50 / p95、每次查询的 token；
   - database：SQL 执行成功率、结果正确率（与 `answer` 中的关键值比对）、守卫拦截次数；
   - api：选对操作的比例、调用成功率。
2. **`runEval`**：
   - 后台执行，结果写进 `.takt/knowledge/<id>/evals/runs/<runId>.json`。
   - 每个变体对所有 active 用例逐条查询，变体可以指定版本和检索参数覆盖。
   - **诊断**，按相关 ref 的位置判定：
     - 在 topK 内：ok；
     - 在 top 50 内、topK 之外：`low_rank`；
     - 在索引里、但不在 top 50 内：`not_retrieved`；
     - 不在索引里：`no_doc`。
   - **比较**：有两个变体时，逐用例比较 Recall@10，统计胜、负、平。
     - Wilson 区间：对"胜 / (胜 + 负)"计算 95% 区间；
     - verdict：
       - 区间下界 > 0.5：better；
       - 区间上界 < 0.5：worse；
       - 胜负都为 0：same；
       - 其他情况，以及有效样本少于 5：inconclusive。
3. **`publishGate`**：用候选版本和已发布版本在全部 active 用例上做比较。
   - 通过条件，三条同时满足：
     - Recall@10 的下降不超过 5 个百分点；
     - 比较结论不是 worse；
     - `defect` 来源的用例全部在 topK 内命中。
   - 没有 active 用例时直接通过，原因写"无评测用例，首次发布"。
   - 不通过时返回原因列表。用 `force` 强制发布时需要提供 reason，并写进审计。
4. **`synthesizeCases`**：
   - 需要 `chat`，没有就报"需要配置模型"。
   - 从已发布版本随机抽取文档块，每块出 1–2 个问题，`relevant` 为该块的 ref，grade 3。
   - 生成的用例为 `status: 'candidate'`、`source: 'synthetic'`。
5. **`harvestCases`**：
   - 从 `queries.jsonl` 里选出被 `used` 标记过的查询，生成候选用例：`relevant` 为被引用的 ref，grade 2。
   - 按规范化后的查询文本去重，跳过已经存在的用例。
6. **`knowledgeRisks`**：以下任一情况产生 `knowledge` 类风险。
   - 构建失败；
   - 状态为 `stale` 超过 3 天；
   - 最近一次评测的 Recall@10 比上一次低 5 个百分点以上；
   - 7 天无结果率超过 30%（至少 20 次查询）。
7. **测试**：
   - 各指标对照手算结果；
   - 诊断的四种情况；
   - 比较和 Wilson 区间；
   - 门槛的通过与不通过，以及 force；
   - 合成：用假的 `chat`；
   - 采集和去重；
   - 风险的四种情况。

**完成定义**：

- `npx tsc -b packages/knowledge`；
- `npx vitest run packages/knowledge`。

---

## 任务 m4-integrate（第二批：接线、演示、全量验收）

**负责范围**：

- `packages/server/src/{router,routes,index,space,read-model,commands}.ts`；
- `packages/cli/src/{index,project,runtime-config}.ts`；
- `examples/**`、根目录 `package.json` 的 scripts；
- 各包 `src/index.ts` 的导出；
- 修复接线时发现的其他小问题：只做最小改动，并在交付说明里列出。

1. **server 接线**：
   - 注册路由：`registerStewardRoutes`、`registerKnowledgeRoutes`。
   - 命令表：加入 `crudCommandSpecs` 和 `knowledgeCommandSpecs`。
   - 打开空间时挂上 `stores.kb = createKnowledgeStore(...)`：
     - `sharedRoot` 为 `<根>/.shared/knowledge`；
     - `embed` 和 `chat` 按空间配置的模型构造。
   - 管家的 `chat`：用 harness 包的 provider 构造。
     - 模型来源依次为：用户偏好的 `harness.model` → 默认空间配置的 `steward.harness` → 空。为空时走规则降级。
     - `ServerInfo.steward` 如实填写。
   - `SpaceSummary.risks`：取管家风险引擎里该空间 `open` 状态的风险数。
   - 管家的 `extraRisks` 接 `knowledgeRisks`。
   - `StewardSpace.postToLead`：复用群聊里 `@lead` 的触发方式，作者为 `{ type: 'agent', role: 'steward', harness: 'steward' }`。
2. **CLI 接线**：
   - 注册 `steward`、`kb`、`req` 和 `space` 的新子命令；
   - `openStores` 时挂上 `stores.kb`，引擎运行时也要能用到它。
3. **示例与演示**：
   - 给 `examples/standard-delivery` 加上：
     - 一个 rag 知识库：语料用示例自己的 `docs` / `inputs`；
     - 一个 sqlite 数据库知识库：夹具库放在 `examples/standard-delivery/fixtures/shop.db`，由脚本生成，不提交二进制。在 `.gitignore` 里加上它，并在演示开始时生成；
     - 一个 5 条用例的评测集。
   - 新增 `npm run demo:steward`（`examples/standard-delivery/demo-steward.ts`）：在规则降级模式下依次执行：
     1. 问"现在进度怎么样"，回答要带引用；
     2. "新建需求 导出支持按月份筛选" → 提案 → 批准 → 执行 → 撤销；
     3. 打印风险和汇报。
   - `demo:standard` 增加知识库段：构建 → 查询 → 评测 → 发布。
4. **全量验收**：
   - `npm run typecheck`；
   - `npx vitest run`；
   - `npm run demo`、`npm run demo:standard`、`npm run demo:chat`、`npm run demo:quick`、`npm run demo:steward`；
   - 把 `examples` 复制到 `/tmp/takt-m4-int`，后台启动 `npm run takt -- serve --spaces /tmp/takt-m4-int --port 4882`，用 curl 依次走一遍：
     - `/api/server`；
     - 新建空间；
     - 在空间里新建需求；
     - 管家：建会话 → 读 stream 直到 done；
     - 提案：批准 → 撤销；
     - `/api/steward/risks`、`/api/steward/digest`；
     - 知识库：`kinds` → 新建 rag → 上传 → 构建（轮询到成功）→ 查询 → 评测 → 发布；
     - 绑定。

     检查完关闭该进程。
