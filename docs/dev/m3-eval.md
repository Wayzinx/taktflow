# 开发简报：M3 评测与归因（docs/design/20）

**先读**：`AGENTS.md`、`docs/design/20-评测与归因.md`、`docs/design/19-外部参考与改进.md`（第一批已经实现的能力：完成标准、失败指纹、评审修订与问题延续、经验库、命令注册表）。
**协议已加好**，不要改 `packages/core/src/{types,interfaces,api}.ts`：
- types.ts：`NodeRecipe`、`node.recipe` 事件、`ArtifactKind 'defect'`、`Defect`、`DefectOrigin`、`MissReason`、`DefectAttribution`、`EvalTarget`、`EvalCase`、`EvalVariant`、`EvalCaseResult`、`EvalComparison`、`EvalRun`、`SnapshotNode.writeScope`、`checks[].role`、`TaktConfig.paths.evals`；
- interfaces.ts：`ProjectStores.paths.evals`；
- api.ts：`NodeDetail.recipe`、`NodeScorecard`、`EvalCollectRequest`、`EvalRunRequest`、`DefectDetail`、`DefectReportRequest`、`DefectConfirmRequest`，以及路由表"评测与归因"一节。

---

## 任务 m3-eval（后端）

**负责范围**：
- 新建 `packages/core/src/eval/**`、`packages/core/src/defects/**`；
- 引擎配方记录：`packages/core/src/engine/{execution,harness}.ts` 中与配方相关的最小改动，新建 `engine/recipe.ts`；
- `packages/core/src/store/project.ts` 的 `resolvePaths`（加 evals：新布局为顶层 `evals/`，旧布局为 `.takt/evals`）；
- 新建 `packages/core/src/commands/eval-commands.ts`；
- 新建 `packages/server/src/eval-routes.ts`（导出 `registerEvalRoutes`）；
- 新建 `packages/cli/src/commands/{eval,defect}.ts`（导出 `registerEvalCommands`、`registerDefectCommands`，签名与现有命令注册方式一致）；
- `templates/agents/{auditor,evaluator}.md`；
- 以上文件的测试。

**注意**：server / cli 的入口注册（router、cli index）由 m3-integrate 负责，你不要改 `router.ts`、`routes.ts`、`cli/src/index.ts`。`packages/core/src/index.ts` 只追加导出行。

1. **配方**（`engine/recipe.ts`）：agent / review（作者、评审者、裁决者各一条）/ judge / planner 节点和 rubric 门禁调用 harness 前，计算并发出 `node.recipe`：
   - 角色档案内容哈希；
   - prompt 模板哈希：静态字符串直接哈希，函数取 `fn.toString()`；
   - 实际同步的技能：技能目录内文件按路径排序后的内容哈希；
   - harness、模型、effort、workflow 版本；
   - 本次召回的经验 id。
   - `recipeKey` = 除 lessons 外字段规范化 JSON 的 sha256 前 16 位。
   - 同一节点同一次执行只发一条（review 节点按角色各一条）。
2. **成绩单**（`eval/scorecards.ts`）：`scorecards(stores, { by, workflowId? })` → `NodeScorecard[]`，口径见设计文档第 2 节：
   - 一次通过率；
   - 评审负担：该节点产物作为评审目标时的轮数、打回、问题数；
   - 人工改写：`artifact.edited`（人）按 impact 分；
   - 完成标准未满足、指纹抑制；
   - 下游归因：失败用例 / 脚本 / 代码沿 producedBy 找到产出节点，按判决类别计数；
   - 已确认缺陷的引入与漏检；
   - 用量、时长；
   - 按配方的趋势。
   - 退化判定：最近一个配方的执行 ≥ 3 次且一次通过率比上一个配方低 20 个百分点以上，或已确认的逃逸缺陷增加 → `suspected`。
3. **缺陷**（`defects/`）：
   - `reportDefect`：写存放区 `defects/<id>.md`（kind `defect`，frontmatter 存结构化字段），id 为 `D-<序号>`。
   - `precheckDefect`：确定性，不调模型。
     - 关联 AC 在追溯图里有没有用例；
     - 用例最近执行的证据；
     - 涉及代码文件由哪个任务节点改的（worktree 分支提交 → 节点；读不到就留空）；
     - 这些产物经过的评审、门禁节点。
   - `attributeDefect`：用 `auditor` 角色（新会话、只读）读缺陷、预检结果和沿溯源链的各环节产物，按 `DefectAttribution` 的 schema 输出，写 `defects/<id>.attribution.json`，状态改为 `attributed`。auditor 必须不同于任何产出这些产物的角色，否则拒绝。
   - `confirmDefect`：人确认或修改，写 `confirmed`，状态改为 `confirmed`；记审计（产物版本 + reason）。
   - 确认后自动为 `introducedAt.nodeId` 和每个 `missedBy` 节点生成回归评测用例（source `defect`）。
4. **评测用例**（`eval/cases.ts`）：存 `paths.evals/<目标 slug>/<id>.json`。
   - `collectCases(stores, req)`：历史中"产物被评审打回或被人语义修改过"的 agent 节点执行 → 一个用例。
     - 输入：该执行的 inputs 版本内容快照；
     - 节点定义：快照；
     - prompt：`context.assembled` 或 `NodeDetail.prompt` 里的实际文本；
     - 参考答案：最终通过的版本；
     - checks：节点的 completion。
   - 已确认缺陷 → 回归用例：带 `mustFind` / `mustNotIntroduce`。
   - 技能自带用例：`skills/<name>/evals/*.json` 读入（格式同 EvalCase，target 为 skill）。
5. **回放**（`eval/runner.ts`）：`runEval(deps, req)`。
   - 每个用例 × 每个变体，在临时目录物化输入，复用临时任务的单节点 workflow 机制，用沙箱跑被测节点，应用变体覆盖（技能目录、prompt 文件、角色档案、harness / 模型）。
   - 输出快照存 `.takt/evals/runs/<run>/<case>/<variant>/`。
   - 判分：
     - completion checks 由独立 `evaluator` 角色核对证据；
     - commands 在输出目录执行；
     - rubric 与参考对比用 judge 模型（必须不同于被测模型，相同则报错）。
     - pass = 全部确定性检查通过，且 rubric 分 ≥ 阈值，且 mustFind / mustNotIntroduce 满足。
   - 配对比较 `EvalComparison`：
     - 同一用例比较 pass，pass 相同再比分数，差 ≥ 5 分算胜负；
     - verdict 规则：负 > 胜 → worse；胜 > 负 且回归用例全过 → better；胜负相等 → same；用例数 < 3 → inconclusive。
   - 运行记录存 `.takt/evals/runs/<id>.json`，后台执行，状态可轮询。
6. **命令**（`commands/eval-commands.ts`，导出 `evalCommandSpecs(deps)`，形状与注册表一致）：
   - 查询：`eval.scorecards`；
   - 写：`defect.report`、`defect.attribute`、`defect.confirm`、`eval.collect`、`eval.run`。
7. **server**（`eval-routes.ts`）：实现 api.ts"评测与归因"一节的全部路由；`NodeDetail.recipe` 由 m3-integrate 在读模型里接，你导出 `recipeOf(events, nodeId)` 供它用。
8. **CLI**：
   - `takt eval scorecards [--by node|recipe|skill] [--workflow]`；
   - `takt eval collect [--target ..] [--defects]`；
   - `takt eval run <target> --variant '<json>' [--variant ..] [--judge ..]`；
   - `takt eval show <run>`；
   - `takt defect report <REQ> --title --desc --severity`；
   - `takt defect attribute <REQ> <D-1>`；
   - `takt defect confirm <REQ> <D-1> [--note]`。
9. **测试**：用 mock harness 端到端覆盖。构造一次运行：PRD → 测分 → 用例 → 实现，然后录入一个"AC-2 没有用例覆盖"的缺陷。期望：
   - 预检得出 `acCovered: false`；
   - 归因（mock 剧本）为引入于实现、漏检于测分；
   - 确认后生成 2 个回归用例；
   - 成绩单里测分节点 `escapes` / `detection.missed` 各 +1；
   - 用两个变体跑回放，比较结果为 better。
   - 另测：配方在技能内容改变后 recipeKey 变化，经验 id 变化时不变。

**完成定义**：
- `npx tsc -b packages/core packages/server packages/cli`；
- `npx vitest run packages/core/src/eval packages/core/src/defects packages/core/src/engine`；
- `npm run demo`。

---

## 任务 m3-web-eval（Web，Claude）

**负责范围**：
- `packages/web/src/api/**` 中评测与缺陷相关的部分：DataSource、client、新建 `mock-eval.ts`；
- 新建 `pages/eval/**`、`pages/requirement/defects-tab.*`、`pages/run/recipe-section.*`；
- 在 `app.tsx`、`components/layout.*`（导航）、`pages/requirement/index.tsx`（Tab）、`pages/run/node-drawer.tsx`（挂载配方区）里各加挂载点。

1. **评测页** `/s/:space/eval`：
   - 成绩单表：维度切换 节点 / 配方 / 技能；
   - 列：一次通过率、评审负担、人工改写、未满足、抑制、下游判决、逃逸、检出率、成本；
   - 配方趋势小图，退化标记；
   - 行点开看详情和最近执行。
2. **评测运行**：列表、新建（选目标与用例、填变体覆盖）；运行详情的 A/B 对比：总览（verdict、胜负平、通过率、平均分、回归用例）和逐用例对比（两边输出摘要、判分理由，点开看输出快照）。
3. **需求页"缺陷"Tab**：
   - 录入表单；
   - 列表；
   - 归因视图：在阶段条和简化追溯链上用两种标记标出"引入"（实心）和"漏检"（空心 + 原因）；预检结果；改进建议；确认 / 修改归因（需备注）；
   - 确认后显示生成的回归用例。
4. **节点抽屉"配方"区**：技能版本（名字 + 短哈希）、prompt 哈希、模型、经验，链到该节点的成绩单。
5. **mock**：
   - 成绩单 8 个节点：一个技能更新后退化，一个评审节点检出率 60%；
   - 2 次评测运行：一次 better，一次 worse 且挂了回归用例；
   - REQ-001 一个已确认缺陷，REQ-002 一个归因中缺陷。

遵守 `docs/dev/m3-web.md` 的动效规范与设计系统；完成定义同 M3 Web：`npm run build -w @taktflow/web`、`npm run motion:audit -w @taktflow/web` 通过，最多 3 张截图自检。
