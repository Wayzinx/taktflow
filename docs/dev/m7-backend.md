# 开发简报：M7 后端（管家 Solo：实体视图、跨空间找、首页推荐；docs/design/28）

**先读**：`AGENTS.md`、`docs/design/28-管家Solo与实体视图.md`（P1 范围）、`docs/design/22`（管家原则）、`docs/design/24`（可视化块与 `show`）。

**协议已经加好**，不要改 `packages/core/src/{types,interfaces,api}.ts`；确需改动写进交付说明的"协议变更请求"。本轮新增（api.ts）：

- 路由表"管家 Solo"一节：`GET /api/steward/find`、`GET /api/steward/picks`；
- `StewardBlock` 加 `entity`（`view` / `ref` / `focus?` / `snapshot`）与 `pick`（`items: StewardEntityCandidate[]`）；
- `StewardEntityView`、`StewardEntitySnapshot`、`StewardEntityCandidate`、`StewardFindType`、`StewardFindResult`、`StewardPick`。

**通用要求**：
- 只跑自己范围的测试。完成前跑 `npm run demo`、`npm run demo:standard`、`npm run demo:steward`，都不能变红。
- 错误信息用中文，并说明下一步。
- 测试里不要真的调用付费模型。

---

## 任务 m7-backend

**负责范围**：
- `packages/core/src/steward/`（新文件放这里，例如 `find.ts`、`entity.ts`）；
- `packages/server/src/steward-routes.ts` 及其测试；
- `evals/` 下管家评测的场景与夹具；
- `examples/` 下 steward 演示，只做必要的最小改动。

不要动 `packages/web/`，前端同时在改。

1. **快照**：新增 `entitySnapshot(space, ref)`，从存储读出 `StewardEntitySnapshot`。
   - **需求**：
     - `title` 为需求标题；
     - `stages` 由 `RequirementSummary.stages` 换算，`waiting_human` 记为 `waiting`；
     - `status` 写成人话，例如"研发测试 · 失败判决在跑"、"对齐冻结 · 等你确认"、"已交付"、"还没开始"；
     - `tone` 与状态色一致，有等人的就是 `waiting`；
     - `summary` 写"N 件等你决定"这类补充，没有就省略。
   - **运行**：`title` 为 workflow 标题加短运行号，`stages` 来自 `RunDetail.stages`，`status` 写当前节点和它的状态。
   - **节点**：`title` 为节点标题；`status` 写状态、harness 和 `activity`（如果有）。
   - **空间**：`title` 为空间名；`status` 写"N 个进行中 · M 件等你"。
   - 复用 tools.ts 里已有的需求泳道和状态推导，不要另写一套口径。
2. **`entity` / `pick` 块校验**（`normalizeBlocks`）：
   - **ref 必须看得见。**
     - 缺 `spaceId` 时，只有在唯一能确定空间的情况下才补齐，否则丢弃并写 issue。
     - view 和 ref 类型必须匹配：`card` / `stages` 配需求，`attention` 配需求或空间，`dag` 配运行，`node` 配节点且带 `parent` 运行 id。不匹配就丢弃并写 issue，issue 回给模型。
     - `dag` 的 `focus` 必须是该运行图里的节点，否则去掉 `focus`。
   - **快照**：模型给的 `snapshot` 一律丢弃，由第 1 条重新生成。
   - **数量**：每条消息最多 3 个 `entity`、1 个 `pick`；`pick` 的候选 2–5 个，每个候选同样校验 ref 并写快照。
   - **`describeBlocks`** 给这两种块各写一行回给模型。例如：`需求卡 hello-delivery/REQ-002 订单导出支持 CSV：研发测试 · 失败判决在跑；1 件等你确认`。
3. **`find` 工具**（同时开放 HTTP 接口 `GET /api/steward/find`）：
   - **入参**：`q`；可选 `types`（`StewardFindType[]`）、`spaceId`、`limit`（默认 8，最多 20）。
   - **范围**：调用者看得见的全部空间，`prefs.mutedSpaces` 排除。会话 context 里引用过的空间和需求加权。
   - **排序**：编号精确命中 > 标题模糊匹配 > 最近有动静。
     - 编号要容忍大小写、`REQ 2` / `req-02` 这类写法；差一位的编号可以命中，但分数低于精确命中。
     - 运行号支持尾号（例如 `0002`）。
     - 中文标题用子串加双字重叠打分，忽略"那个 / 需求 / 现在 / 到哪了"这类意图词和虚词。
     - 节点只在命中需求的最近运行里找（标题或 id）；workflow 和知识库按 id / 标题匹配。
   - **出参**：`StewardFindResult`，每条带 `snapshot`、`why`、`score`、`match`。
   - **歧义**：前两名分差小于第一名的 15%，或者同为标题命中且分差很小时，`ambiguous: true`。
   - **注册**：加进 `TOOL_LABELS` 和工具说明。
4. **`picks`**（`GET /api/steward/picks?limit=`，默认 6）：
   - 范围是看得见的空间里还没交付、或 24 小时内刚交付的需求。
   - 按"等你 > 失败 > 有高风险 > 24 小时内有变化 > 在跑"排序，同级按最近动静。
   - 每条一个 `StewardPick`（ref 为需求，带快照、`reason` 和 `why`）。
   - 一个空间最多占一半名额，避免一个空间刷屏。
5. **`show` 工具与提示词**：
   - `show` 的 `blocks` 接受 `entity` / `pick`。
   - 系统提示词和工具说明补三条规则：
     - 问某个需求 / 运行 / 节点"到哪了、卡在哪、在跑什么"时，先 `find`（空间不确定时），再 `show` 一个 `entity` 块；正文不超过 3 句，不要再用 table 或 lanes 复述同一个对象。
     - `find` 返回 `ambiguous` 时 `show` 一个 `pick`，问"你说的是哪一个"，不要猜。
     - 用户给了 context 里的需求时直接用它，不用再 `find`。
6. **离线路由**（`offline.ts`，没配模型时）：
   - **先识别对象**：用 `REQ-xxx`、`run-…` 和去掉意图词后的标题片段调用 `find`。
   - **再按意图选视图**：
     - "到哪了 / 进度 / 状态 / 卡在哪"出 `card`；
     - "阶段"出 `stages`；
     - "运行 / 流程图 / 画布 / DAG / 节点图"出最近一次运行的 `dag`；
     - 命中节点时出 `node`；
     - "等我 / 待办 / 审批 / 要我决定"出 `attention`（需求或空间）。
   - **歧义**时出 `pick`，正文写"找到几个，你说的是哪一个？"。
   - **没识别出对象**时保持现有行为（空间进度、风险、待办预设，以及新建需求 / 空间）。
   - 正文一句话即可，例如"REQ-002 现在在研发测试，失败判决在跑。"。
7. **测试**：
   - 快照在各种状态下的人话与 `tone`；
   - 校验：缺 `spaceId`、看不见、类型不匹配、超量、`focus` 不在图里、模型伪造 `snapshot`；
   - `find`：精确 / 大小写 / 差一位 / 尾号 / 中文标题片段 / 同名跨空间（`ambiguous`）/ `mutedSpaces` / 只在看得见的空间；
   - `picks` 排序与每空间名额；
   - 离线路由的每种意图与歧义；
   - HTTP：两个新接口的参数校验（`q` 为空 400）和按用户隔离。
8. **评测**：`eval:steward` 加离线确定性场景，不需要模型也能跑：
   - "导出报表那个到哪了"出 REQ 的 `card`；
   - 编号写错一位仍命中；
   - 同名跨空间出 `pick`；
   - "REQ-002 的运行图"出 `dag`。

   真实模型场景（需要环境变量时才跑）再加一条：问进度时出 `entity` 块，而不是 table。

**完成定义**：
- `npx tsc -b packages/core packages/server packages/cli` 在你的范围内没有错误；
- 你负责的测试通过；
- 三个 demo 不变红；
- 最后输出交付说明（中文）：做了什么（按编号）、没做什么、已知问题、协议变更请求（如有）、文件清单。
