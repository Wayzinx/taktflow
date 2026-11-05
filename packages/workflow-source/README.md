# workflow-source

`.workflow.ts` 的结构解析、最小文本编辑、运行校验及修订存储。所有公共函数从 `@taktflow/workflow-source` 导出；协议类型使用 `@taktflow/core`。

```ts
const store = createWorkflowStore({
  dir: '/space/workflows',
  historyDir: '/space/.takt/workflow-history',
})
const current = await store.get('sdlc')
const result = await store.edit('sdlc', {
  baseRev: current.rev,
  author: { type: 'human', id: 'alice' },
  reason: '更新提示词',
  edits: [{ op: 'setProp', id: 'spec', key: 'prompt', value: { kind: 'literal', value: '新提示词' } }],
})
if ('error' in result) {
  // conflict：含 base / ours / theirs / merged / currentRev。
  // validation：含 diagnostics，原文件没有写入。
}
const stop = store.watch((event) => console.log(event), (error) => console.error(error))
// 服务关闭时停止轮询并等待正在进行的扫描结束。
await stop()
```

- `parseWorkflowSource(source, fileName?)` 返回 `model / diagnostics / spans`。`spans` 是本包的源码定位信息，含 TypeScript AST，不应作为 HTTP 协议发送。
- `lintWorkflowSource(source)` 检查受限子集和 TS 语法，不运行源码、不做类型检查。函数、变量引用、嵌套展开等属性表达式保留为代码值；不能唯一定位的节点 id、计算属性名、对象展开等结构会使画布只读。
- `applyEdits(source, edits)` 返回 `source / summary / diagnostics`。`diagnostics` 用于报告无法自动清理的代码依赖；只读源码抛出带诊断的 `WorkflowSourceError`。省略 `addNode.after` 追加到末尾，`null` 插到开头。`moveNode.parent` 省略或为 `null` 时目标是顶层数组。
- `validateWorkflowSource(file)` 在独立 Node + tsx 进程中加载文件、执行 core DAG 校验并生成快照，15 秒超时。stdout 与返回结果分离。合法但不满足画布子集的文件仍可返回运行快照。
- `readWorkflowLayout(dir, id)` / `writeWorkflowLayout(dir, id, layout)` 读写 `<id>.layout.json`；store 也提供 `getLayout / setLayout`。成功保存或观测到可解析的外部节点删除时清理失效坐标。
- store 提供 `list / get / edit / replaceSource / revisions / revision / rollback / watch / expectExternalChange`。`edit` 和 `replaceSource` 的请求在 core 请求类型上增加必填 `author: Actor`，返回 `WorkflowDocument | WorkflowConflict | { error: 'validation'; diagnostics }`。未知 workflow / 修订、I/O 错误和无效操作抛出 Error。
- `list` 和 `get` 会保留对外返回的源码修订。`revision(id, rev)` 返回 `{ revision, source, diff }`，diff 相对记录的父修订；回滚会追加审计记录，同一源码 hash 可在日志中出现多次，按 rev 查询取最近一次。
- 冲突时 `ours` 是磁盘当前源码，`theirs` 是请求在基线上的修改。使用 `git merge-file --diff3`；因此是否能自动合并取决于文本行的重叠情况。合并结果再次经过解析和运行校验。
- `watch` 每秒轮询文件 mtime / ctime / 大小，对变化文件比较源码 hash，忽略旁路布局和校验临时文件。本包保存直接发事件，不重复记为外部修改。外部无效源码仍保留修订并发事件，调用 `get` 获取诊断。`expectExternalChange` 的作者只用于下一次实际观测到的源码变更；连续发生在同一轮询间隔内的写入只能观察到最终状态。

实现边界：

- 本包不接入 server / CLI，也没有运行记录存储，`WorkflowSummary.runs` 为 0。目录参数指向 workflow 文件目录，返回的 `file` 相对其父目录（空间根目录）。
- 校验待保存源码时在原文件同目录创建临时 `.mts` 并在 finally 删除，保留相对 import 和包解析上下文；依赖自身 `import.meta.url` 文件名的顶层逻辑应避免用于 workflow 元信息。
- 同进程多个 store 通过 core `withLock` 串行化写入；保存前重读文件可检测校验期间的外部修改。文件系统没有面向任意外部写入者的 compare-and-swap，因此最终重读与 rename 之间不提供跨进程事务保证。
- `gitCommit` 默认关闭。启用时仅提交当前源码文件，使用 Actor 生成作者，保留其他已暂存文件；提交失败会明确报“源码已保存，但 git 提交失败”。实际提交应由调用方按部署策略启用。

验证命令（仓库根目录）：

```sh
npx tsc -b packages/workflow-source
npx vitest run packages/workflow-source
```
