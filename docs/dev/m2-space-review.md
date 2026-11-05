# 开发简报：m2-space-review（项目空间存储 + 群聊存储 + 评审节点 + 打回重做 + 作者版流水线）

**负责范围**：`packages/core/src/**`（store、engine、insights、dsl、snapshot 等）、`templates/**`、`examples/standard-delivery/**`（新建）、`examples/hello-delivery/**`（只做兼容性修改）、根 `package.json` 的 `scripts.demo:standard`。
**不要改**：`packages/core/src/{types,interfaces,api}.ts` 以外的协议（这三个文件只允许做一件事：把 `ProjectStores.paths` 和 `ProjectStores.chat` 从可选改为必填，并删掉"M2 … 改为必填"的注释）；server / cli / web / harness / 新包。

**背景**：先读 `docs/design/14-项目空间.md`、`15-需求群聊与Lead-Agent.md`（只做存储部分）、`18-评审机制与默认流水线.md`；协议见 types.ts 里的 `ReviewNodeDef / ReviewerSpec / ReworkPolicy / ReviewRecord / ReviewResponse / ReviewRound`、`NodeContext.feedback`、`NodeState.round / reworks`、`SnapshotNode.review / repo`、事件 `review.* / rework.started`、`TaktConfig.members / repos / paths / lead`、`Room / RoomMember / RoomMessage`，interfaces.ts 的 `ChatStore`。

## 1. 项目空间的目录约定
- `resolvePaths(projectDir, config)`：`config.paths` 优先；否则如果存在旧目录（`.takt/workspaces`、`.takt/agents` 或 `.takt/workflows`）用旧布局，否则用新布局：`agents/ workflows/ skills/ knowledge/ requirements/`（相对空间根）。
- `initProject` 默认创建新布局（`agents workflows skills knowledge requirements .takt`），把 templates 复制到新位置由 CLI 负责（不在本任务），但 `initProject` 要能接受 `layout: 'legacy' | 'space'` 选项。
- `openProject` 填 `ProjectStores.paths`（必填）；`loadProfiles`、workspace 根目录、workflow 列表都改用 paths；旧项目（hello-delivery）行为不变，现有测试全过。
- 新增 `listSkills(paths.skills)` → `SkillRecord[]`（读 `skills/*/SKILL.md` frontmatter 的 name / description）。

## 2. 群聊存储 `FsChatStore`
- `.takt/chat/<REQ>/room.json` + `messages.jsonl`；seq 递增、同进程串行追加、跨进程轮询 tail 订阅（复用 fs-events 的做法，抽公共函数，不要复制粘贴）。
- `createRequirement` 后自动 `ensureRoom`：成员 = 负责人（有 owner 时）+ `{ id: 'lead', kind: 'lead', name: 'Lead' }`，并发一条 system 消息"需求已创建"。
- 引擎在关键事件时向房间发 system / attention 消息：运行开始 / 结束、阶段完成、产生待办（kind 'attention'，refs.requestId）、评审每轮结论（kind 'progress'）、打回重做。用一个小的事件 → 消息映射模块，不要散落在各处。

## 3. review 节点（`engine/nodes/review.ts`）
按 docs/design/18 实现：
- 每轮：对每个 reviewer 用其角色（`ReviewerSpec.harness` > 角色默认）**新会话**评审，要求输出 `{ verdict, score?, summary, issues: ReviewIssue[] }`（schema 校验）；评审者可以并行（受引擎并发上限约束）。prompt 包含：被评审产物路径与版本、`focus`、`checklist`、`rubric`、上一轮该评审者的问题及作者回应（第 2 轮起）。
- `pass`：`all`（全部 approve）/ `majority` / `{ minScore }`（所有评审者 score ≥ minScore 且无 reject）。
- 不通过且未到 `maxRounds`：作者用 author 角色新会话修改产物，输出 `{ responses: ReviewResponse[] }`（每个 issue 一条），收集产物新版本。
- 代码评审：`target: { code: { repo, base } }` 时，被评审对象是该运行中对应仓库的改动：本任务先实现为"读取存放区 `tasks/` 下各任务的 diff 文件"（`tasks/<key>.diff`），worktree 集成在 M2-B 做，留好函数边界。
- 记录：每轮写 `reviews/<nodeId>/round-<n>.json`（ReviewRound），结束时写 `reviews/<nodeId>/summary.md`（中文，按轮次列结论、问题、回应），kind = 'review'；事件 `review.round`、`review.response`、`review.exhausted`。
- `humanSignoff`：agent 通过后创建 approve 待办；reject → 视为本轮不通过。
- 轮次用完：`human` → 待办（choice：放行 / 打回 / 终止）；`fail` → 节点失败；`{ rework, maxReworks }` → 见第 4 节。
- NodeState.round 记录当前轮次；结果 `ns.result = { passed, rounds }`。

## 4. 打回重做（rework）
- 引擎支持"把同一作用域内从 rework 目标节点到本 review 节点之间的所有节点（含两端）重置为 pending"，目标节点 `reworks += 1`，记 `rework.started`（含 feedback 摘要与被重置节点列表），并把 feedback 通过 `NodeContext.feedback` 注入：agent 节点的 prompt 末尾追加"上一次评审未通过，意见如下：…"。
- `reworks` 超过 `maxReworks`（默认 1）→ 待办交人。
- 重置的节点产物保留历史版本（不删），stale 规则照旧。
- DSL：新增 `review()` 构造函数；静态校验：rework 目标存在、在 review 节点上游（同作用域）、reviewers 非空、maxRounds ≥ 1、author.role 存在于角色（运行时校验即可）。
- `snapshotWorkflow` 填 `SnapshotNode.review`；`buildRunGraph` 画出 review 节点及 rework 回边（GraphEdge kind 'route'，label '打回'）。

## 5. 读模型
- `listReviews(stores, requirementId)` → `ReviewSummary[]`；`reviewDetail(stores, runId, nodeId)` → `NodeDetail['review']`（server 在 M2-B 接入，这里导出函数并测试）。
- 度量：`RequirementMetrics` 不改协议，评审轮次、打回次数在 `reviewSummary` 里体现即可。

## 6. 作者版标准流水线
- `templates/workflows/taktflow-standard.workflow.ts`，结构见 docs/design/18 的表格；必须满足 docs/design/16 的"受限子集"写法（defineWorkflow 对象字面量、nodes 数组字面量、每个节点一次构造函数调用、动态逻辑写成具名函数放在文件顶部或 `taktflow-standard.hooks.ts`）。
- 评审角色：PRD 由 architect（研发视角）+ test-designer 评；系分由 pm + test-designer + reviewer（架构视角，focus 写明）评；测分由 pm + architect 评；代码评审 reviewer；脚本评审 test-designer。轮次、打回目标、是否人工确认都用 workflow args 可调（默认 maxRounds 3、maxReworks 1、humanSignoff true）。
- 角色档案补齐：如需要新角色（例如 `code-reviewer`），放 `templates/agents/`。

## 7. 示例与演示
- `examples/standard-delivery`：**新布局**的空间（agents/ workflows/ skills/ knowledge/ requirements/），复用 hello-delivery 的问候语业务；mock 剧本覆盖标准流水线，并刻意演示：PRD 评审第 1 轮 request_changes → 作者修改 → 第 2 轮通过；系分评审 3 轮都不通过 → 打回重新系分 1 次 → 通过；代码评审 1 轮通过；研发测试 Loop 第一轮失败 → 判决 → 修复 → 通过。
- `npm run demo:standard`：跑完并校验（运行 succeeded、上述每个场景的事件都出现、reviews/ 记录齐全、audit verify 通过、群聊里有对应 system / progress 消息）。
- `npm run demo`（hello-delivery，旧布局）必须保持通过。

## 完成定义
`npm run typecheck`、`npx vitest run`、`npm run demo`、`npm run demo:standard` 全部通过；新增功能都有单测（review 各分支、rework 次数上限、paths 新旧布局、chat 存储与跨实例订阅）。
