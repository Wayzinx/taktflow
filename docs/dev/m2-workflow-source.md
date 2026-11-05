# 开发简报：m2-workflow-source（workflow 源码的解析、最小文本编辑、校验、修订）

**负责范围**：`packages/workflow-source/**`（已建好空包，依赖 typescript、tsx 已装）。不要改其他包；server / cli 的接入在 M2-B 做。

**背景**：先读 `docs/design/16-工作流协同编辑.md`；协议在 `packages/core/src/api.ts`：`EditableValue / EditableNode / EditableWorkflow / WorkflowDiagnostic / WorkflowEdit / WorkflowLayout / WorkflowRevision / WorkflowSummary / WorkflowDocument / WorkflowConflict / WorkflowChangedEvent`。被编辑的文件形如 `templates/workflows/sdlc.workflow.ts`（注意它目前有不少 `hooks.xxx` 之外的写法，用来验证"不满足子集时只读"）。

## 要实现

### 1. 解析：`parseWorkflowSource(source, fileName) → { model: EditableWorkflow; diagnostics: WorkflowDiagnostic[]; spans }`
- 用 TypeScript 编译器 API（`ts.createSourceFile`，不做类型检查）找 `export default defineWorkflow({...})`。
- 受限子集规则见 docs/design/16。违反时 `editable=false`，诊断里写清哪一行、为什么（例如"nodes 不是数组字面量""第 3 个节点不是构造函数调用""节点参数里使用了展开运算符"）。
- 属性值：字符串 / 数字 / 布尔 / null、以及只由这些组成的数组和对象字面量（递归）→ `{ kind: 'literal', value }`；其他任何表达式（函数、调用、标识符、模板字符串含插值、展开）→ `{ kind: 'code', code: 原文 }`。不含插值的模板字符串算 literal。
- 节点 kind 由构造函数名决定（agent / script / gate / human / judge / loop / planner / review / subflow）；loop 的 `body` 递归解析为 `EditableNode.body`。
- `spans` 记录每个节点、每个属性、nodes 数组、stages 的源码区间，供编辑使用（内部类型，不出协议）。

### 2. 编辑：`applyEdits(source, edits: WorkflowEdit[]) → { source; summary }`
- 每个操作都是**最小文本替换**：定位到区间后只替换这一段，其余字节原样保留（注释、空行、格式）。多个操作依次应用，每次重新解析。
- `addNode`：按 `after`（null = 开头）插入一行 `kind({ ... })`，属性按插入顺序输出；字面量用稳定的 TS 风格序列化（单引号、对象无多余引号、数组单行；字符串含换行时用模板字符串），代码值原样写入；缩进跟随数组里已有元素。`parent` 为 loop id 时插入其 body。
- `removeNode`：删除该元素及其尾随逗号 / 换行；同时从其他节点的 `needs` 里移除对它的引用（只处理 needs 是字面量数组的情况；是代码值时写 warning 诊断）。
- `setProp`：value 为 null 删除属性；存在则替换值区间，不存在则在对象末尾追加。
- `setNeeds`：等价于 setProp('needs', literal 数组)，空数组时删除属性。
- `moveNode`：同一数组或跨 loop body 移动元素文本。
- `setStages`、`setMeta`：替换对应字面量。
- `summary`：中文的改动摘要，例如"新增节点 review-prd；修改 spec.prompt；删除节点 gate-1"。
- 源码不可编辑（editable=false）时拒绝，抛带诊断的错误。

### 3. 校验：`validateWorkflowSource(file) → { snapshot?: WorkflowSnapshot; diagnostics }`
- 在子进程里用 `tsx` 加载该文件（`node --import tsx/esm` 或 tsx 的 API，子进程是为了避免模块缓存和让坏代码不影响服务进程），调用 core 的 `snapshotWorkflow`（defineWorkflow 本身会做 DAG 校验），返回快照或错误（转成诊断，尽量带行号）。超时 15 秒。

### 4. 布局：`<id>.layout.json` 旁路文件读写（WorkflowLayout）。删除节点时清理布局里的该节点。

### 5. 存储：`createWorkflowStore({ dir, historyDir, gitCommit?: boolean })`
- `list()` → WorkflowSummary[]（id 取 defineWorkflow 的 id 字面量；取不到用文件名）；`get(id)` → WorkflowDocument。
- `edit(id, { baseRev, edits, reason, author })`、`replaceSource(id, { baseRev, source, reason, author })`：
  1. 读当前源码算 rev（sha256）；baseRev 不同 → 用 `git merge-file -p --diff3`（临时文件）以 baseRev 的修订为 base 做三方合并；无冲突则在合并结果上继续，有冲突返回 `WorkflowConflict`。
  2. 应用编辑 → 校验（解析 + validateWorkflowSource）→ 有 error 级诊断时拒绝（返回诊断，不落盘）；
  3. 原子写入；记修订：`historyDir/<id>/<rev>.ts` + `historyDir/<id>/log.jsonl`（WorkflowRevision）；`gitCommit` 且目录在 git 仓库里时提交一次（作者用 Actor 生成）。
- `revisions(id)`、`revision(id, rev)`（含相对父修订的统一 diff，用 `git diff --no-index` 或自己实现均可）、`rollback(id, rev, author, reason)`（等价于 replaceSource 到该修订的源码）。
- `watch(onChange)`：监听目录，文件被外部（AI）直接改了也记一条修订（author 为 `{ type: 'agent', role: 'unknown', harness: 'external' }`，除非调用方先通过 `expectExternalChange(id, actor)` 声明了作者），回调 `WorkflowChangedEvent`。用轮询 mtime（1 秒）实现，跨平台稳定。

### 6. lint：`lintWorkflowSource(source)` → 诊断列表（给 CLI 的 `takt workflow lint` 用）。

## 测试
- 解析：sdlc 模板、taktflow-standard（如已存在）以及若干构造的子集 / 非子集样例；字面量与代码值分类。
- 编辑：每种操作的结果与期望文本**逐字节**比对（含注释保留、缩进）；连续多个操作；删除节点后 needs 清理；loop body 内插入。
- 三方合并：两个人分别改不同节点能自动合并；改同一属性返回冲突。
- 校验：引用不存在的依赖、环、语法错误都能给出诊断；合法文件返回快照。
- watch：外部写入能产生修订与事件。

## 完成定义
`npx tsc -b packages/workflow-source`、`npx vitest run packages/workflow-source` 通过。
