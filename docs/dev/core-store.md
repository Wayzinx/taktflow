# 开发简报：core-store（文件存储 + 读模型）

**负责范围**：`packages/core/src/store/**`、`packages/core/src/insights/**`、`packages/core/src/util/**`，以及在 `packages/core/src/index.ts` 追加导出。不要改 `types.ts / interfaces.ts / api.ts / dsl.ts`。

**背景**：先读 `docs/design/02-总体架构.md`（`.takt/` 目录布局）、`04-公共存放区.md`、`06-追溯与审计.md`、`11-项目总览与度量.md`。

## 要实现

### util/
- `hash.ts`：`sha256(buf|string)`、`canonicalJson(value)`（键排序、稳定输出，用于事件哈希）。
- `glob.ts`：`matchGlob(pattern, path)`（支持 `**`、`*`、`?`，路径分隔符 `/`）和 `listFiles(dir, patterns, { ignore })`（递归，默认忽略 `.git node_modules .takt/objects .takt/runs dist`）。
- `tokens.ts`：`estimateTokens(text|bytes)`：中日韩字符及全角标点每个计 1 token，其余字符数除以 4 向上取整。
- `ids.ts`：`newRunId(now)` → `run-YYYYMMDD-HHmmss-xxxx`；`nextRequirementId(existing)` → `REQ-001` 递增。
- `trace-ids.ts`：从文本抽取追溯 ID：`REQ-\d+`、`AC-\d+(-\d+)?`、`TC-[A-Z0-9-]+`。
- `frontmatter.ts`：解析 markdown frontmatter（用预装的 `yaml` 包），返回 `{ data, body }`。

### store/
- `project.ts`：
  - `initProject(projectDir, { name })`：创建 `takt.config.json`（TaktConfig，默认 workflows: ['.takt/workflows/sdlc.workflow.ts']）和 `.takt/{agents,workflows,workspaces,objects,runs}`；已存在则不覆盖。
  - `openProject(projectDir)` → `ProjectStores`（interfaces.ts）。找不到 `takt.config.json` 时向上查找父目录。
  - `loadProfiles(taktDir)` → `Record<string, AgentProfile>`：读 `.takt/agents/*.md`（frontmatter 字段见 `templates/agents/*.md`，正文为 instructions）。
- `fs-workspace.ts`：实现 `WorkspaceStore`。
  - `requirement.json`、`manifest.json`（`{ artifacts: ArtifactRecord[] }`）、`comments.jsonl` 都在 `.takt/workspaces/<REQ>/` 下；产物最新内容同时写到 `.takt/workspaces/<REQ>/<path>`（人和 Agent 直接读这个），历史内容写 `.takt/objects/<sha256>`。
  - `writeArtifact`：同 sha 与最新版本相同则返回已有版本（不新增）；mediaType 按扩展名推断；traceIds 从文本内容抽取。
  - `FsWorkspaceStore.withdrawArtifact`：沿用版本账本，以空 `sha256` 表示撤回（不对应对象，空文件仍有正常哈希），记作者、原因和 producedBy；默认读取及列表排除撤回，`listArtifacts(id, true)` 和指定旧版本保留历史，新写入可恢复；跨包暂用导出的 `withdrawArtifact` / `listArtifactHistory` 存储入口。
  - `detectUntracked`：遍历存放区目录（排除 manifest/requirement/comments），sha 与清单最新版不一致、或不在清单里的文件。
  - 写文件用"写临时文件再 rename"，避免半写。
- `fs-events.ts`：实现 `EventStore`。`runs/<RUN>/events.jsonl` 只追加；`hash = sha256(prevHash + canonicalJson({seq,ts,runId,nodeId,type,actor,data}))`，首条 prevHash = `"0".repeat(64)`；同进程内串行化追加（Promise 队列）。`subscribe` 用轮询 tail（300ms，按字节偏移读新增行），这样 server 进程能看到 CLI 进程写的事件。`verify` 返回首个断链 seq。
- `fs-runs.ts`：实现 `RunStore`。`runs/<RUN>/state.json`、`workflow.json`、`context/<nodeId>.json`（`{ snapshots, compactions }`；nodeId 里的 `/` 替换成 `__`）。
- `fs-attention.ts`：实现 `AttentionStore`，`.takt/attention.jsonl` 追加记录，读取时按 requestId 归并（后写覆盖先写）。
- `snapshot.ts`：`snapshotWorkflow(def: WorkflowDefinition): WorkflowSnapshot`（去掉函数；动态 prompt 记 undefined；loop body 递归；gate 只留 checks 的 id/kind/title）。

### insights/
实现 `Insights`，外加 server 需要的聚合函数（都只读文件）：
- `buildRunGraph(snapshot, state)` → `RunDetail['graph']`：静态节点 + loop 体（id `<loopId>/<childId>`，parent=loopId）+ planner 展开节点（来自 state.expansions，parent=plannerId）；边：needs → dep；judge.routes → route（label=类别）；planner → 展开节点 expand。
- `stageProgress(snapshot, state)` → `StageProgress[]`。
- `summarizeRun(state)` → `RunSummary`；`summarizeUsage(events)` → Usage。
- `traceGraph(requirementId)`：节点 = 需求、manifest 里的产物、产物 traceIds 里的 AC/TC；边：产物 derivedFrom → derives，用例 covers AC → covers（从 cases/*.json 的 covers 字段读），evidence/<TC>/ → verifies，producedBy → produced。
- `metrics(requirementId)`：从该需求所有运行的事件计算 RequirementMetrics（firstPassRate：每个 loop 第一轮 run 节点结果里 failures/total；loopIterations；humanInterventions = human.answered 数 + 判决路由到 human 的条数；verdicts 分布；usage 汇总；acCoverage 用 spec AC + cases covers + evidence/summary.json）。

## 测试（vitest，临时目录）

- 存放区：写入 → 同内容不新增版本 → 改内容新增版本 → 溯源字段正确 → detectUntracked 能发现直接改动；
- 事件：追加 50 条后 verify 通过；手工改中间一行 data 后 verify 返回该 seq；subscribe 能收到另一个 EventStore 实例追加的事件；
- buildRunGraph：含 loop 和 planner 展开的快照能画出正确的节点与边；
- frontmatter：能解析 `templates/agents/dev.md`。

## 完成定义

`npx tsc -b packages/core` 通过；`npx vitest run packages/core` 通过；交付说明写到简报指定的输出文件。
