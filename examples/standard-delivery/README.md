# 作者版标准交付示例

运行仓库根目录的 `npm run demo:standard`。每次在系统临时目录创建一个独立空间，运行结束后打印运行 ID、评审记录和事件日志路径；证据保留在该目录，示例源码不会被改写。

这是新布局空间：`agents/` 角色、`workflows/` 流程、`skills/` 技能、`knowledge/` 知识、`requirements/` 需求物料；`.takt/` 只放运行状态、对象版本、聊天和待办。复制本目录即可作为自己的空间起点。

流水线与 `templates/workflows/taktflow-standard.workflow.ts` 保持一致，包含需求澄清、PRD 评审、系分评审、测分评审、追溯冻结、任务实现与代码评审、脚本评审、测试与修复循环、影响面、人工准出和知识回流。

演示使用 `mock.json` 预设模型输出，自动确认人工节点；产品用例仍由 Node 实际执行 `src/greet.js`，核对每条用例的输入、期望和实际返回值。Mock 评审结论用于演示流程，不代表真实模型评审或正式准出。

演示脚本会重新打开存储并断言：

- PRD 第一轮要求修改，作者回应并产生新版本，第二轮通过。
- 系分连续三轮不通过，打回重新设计一次后通过；保留四轮评审及历史版本。
- 任务代码评审一轮通过，脚本评审通过，修复代码再次评审。
- 第一轮两个用例中有一个失败；判决为 `product_bug`，修复后第二轮两条均通过。
- 运行 `succeeded`，评审记录齐全，事件哈希链通过，所有产物已登记，聊天中存在运行、阶段、待办、评审和打回消息。

默认评审参数为三轮、一次打回、人工确认。通过 `Engine.start` 的 `args` 可覆盖并固定在运行快照中：

```ts
args: {
  review: { maxRounds: 3, maxReworks: 1, humanSignoff: true },
  reviews: {
    'review-prd': { rework: 'prd', maxRounds: 2 },
    'review-code': { maxRounds: 2 }, // planner 动态子节点使用局部 ID
  },
  caseCommand: 'npm test',
  testScript: 'tests/run-cases.mjs',
}
```

代码评审读取本运行对应仓库各任务工作树的真实 diff，登记到 `tasks/<节点安全名>.diff`；评审作者修改同一任务工作树。集成节点把已评审任务分支合并到各仓库的 `takt/<runId>/integration`，发生冲突时停止并在 `tasks/integration.json` 中记录冲突文件。测试在主仓库的集成工作树中执行，产品修复再次评审、集成后进入下一轮。`args.repo` 可覆盖默认主仓库 `app`。

演示只在系统临时目录内初始化测试仓库并创建任务与集成工作树，不调用外部模型、不推送代码。技能重复同步的既有问题见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)。

## 群聊 Lead 与临时任务

运行根目录的 `npm run demo:chat`。演示在独立临时空间中使用 `chat-mock.json`，不调用外部模型；通过真正的 `chat post` 命令触发 Lead：先询问进展，再要求修改 PRD 的 AC-2。Lead 派发产品任务，经过独立评审后产生 PRD 第 2 版，并发送带运行与产物引用的任务卡片和进度回报。

演示重新打开存储和 HTTP `/api/runs`，断言触发消息、三个 `kind=task` 运行的 `origin`、PRD 版本与来源、任务状态卡片、评审结果和每个运行的审计哈希链。任何断言失败都会非零退出；打印的临时目录保留全部证据。

`chat post <REQ> "@lead ..."` 在命令进程里执行回合并等待派发任务完成或等待人工；`serve` 的群聊回调异步触发同一运行时，且支持多空间隔离。Lead 自身只读，业务修改通过任务完成；workflow 修改只创建审批待办，人批准后才通过 workflow-source 应用。没有附带完整源码的提案，需要审批人在答复中提供完整源码。
