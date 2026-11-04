# 开发简报：knowledge（存量项目知识层）

**负责范围**：`packages/knowledge/src/**`。只依赖 `@taktflow/core` 的类型（KnowledgeSource / KnowledgeQuery / KnowledgeHit / KnowledgeIntent）。

**背景**：`docs/design/08-存量项目知识层.md`。

## 要实现

- `grep.ts`：`createGrepSource({ root, ignore? })`，intents `['symbol']`。优先用 `rg --json`（存在时），否则用 Node 递归读文件做字面匹配；返回命中文件、行号、前后各 2 行作为 snippet；默认忽略 `.git node_modules dist .takt/objects .takt/runs`。
- `wiki.ts`：`createWikiSource({ root })`，intents `['business']`。root 是一个 markdown 目录。召回分两步：先在"入口"（文件路径、一级标题、frontmatter 的 `aliases` / `summary`）里按关键词打分，取前 N 个；再对前 N 个文件做正文关键词匹配取最相关段落作 snippet。中文按字符二元组（bigram）切词做匹配，英文按单词。返回带 `evidenceLevel`：frontmatter 有 `verifiedAt` 且在 30 天内为 `verified`，超过为 `stale`，没有为 `derived`。
- `workspace.ts`：`createWorkspaceSource({ taktDir })`，intents `['business', 'history']`。在 `.takt/workspaces/*/` 的 spec、decisions、reports 里检索（复用 wiki 的打分函数），ref 为 `<REQ>/<path>`。
- `git-history.ts`：`createGitHistorySource({ root })`，intents `['history', 'symbol']`。`git log -S <关键词> --format=...` 取最近 10 条提交，snippet 为提交标题 + 改动文件列表。不是 git 仓库时返回空数组。
- `stubs.ts`：`createCodeGraphSource / createDatabaseSource / createApiRegistrySource`，intents 分别为 impact / schema / fact，`query` 返回空数组，`describe()` 写清如何接入（M1 实现）。
- `router.ts`：`createKnowledgeRouter(sources)` → `{ route(q): KnowledgeSource[]; query(q): Promise<{ hits: KnowledgeHit[]; sources: string[] }> }`。intent 显式给出时选 intents 包含它的源；没给时按关键词猜：包含 `调用|影响|依赖|impact|caller` → impact；`表|字段|口径|schema|column` → schema；`为什么|历史|when|why` → history；像代码符号（含 `.`、`_`、驼峰、`()`）→ symbol；其他 → business。结果按 score 排序、按 `limit`（默认 8）截断，并去重（同 ref 只留最高分）。
- `index.ts`：导出以上全部，外加 `createDefaultSources({ projectDir, taktDir, wikiDir? })`。

## 测试（临时目录造数据）

- grep 能找到符号并带行号；不存在的符号返回空数组；
- wiki：中文问题能命中正确页面，过期页面标 stale；
- router：显式 intent 和关键词猜测各至少 3 个用例；去重和 limit 生效。

## 完成定义

`npx tsc -b packages/knowledge` 通过；`npx vitest run packages/knowledge` 通过。
