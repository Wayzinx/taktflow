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

当前代码评审读取本运行中对应仓库的 `tasks/<key>.diff`。工作树创建和真实 git diff 集成由后续 M2-B 接入 `engine/nodes/review-target.ts` 边界。演示不调用外部模型、不推送代码，也不创建 worktree。
