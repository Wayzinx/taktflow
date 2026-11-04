# taktflow

**按节拍走的 AI 交付流水线。** 需求进来，多个 Agent 按代码定义的 DAG 分工完成澄清、设计、编码、测试、判决修复和准出；每个节点的输入、产物、上下文和判决都落盘、可追溯、可审计、可人工修改后重跑。

> 状态：M0 骨架与 M1 扩展性第一批已完成（1151 条测试）。设计见 [docs/design](docs/design/README.md)。

## 它和别的工具有什么不同

- **验证优先**：用例失败先交给判决 Agent 归因（代码 / 用例 / 脚本 / 环境 / 需求），再路由给对的角色修；修复要过防假通过的 validator。
- **需求级公共存放区**：PRD、会议纪要、spec、系分、用例、证据、报告按需求集中存放，带版本、溯源和评论；所有 Agent 和人从这里取、往这里写。
- **全程可审计**：事件日志哈希链、产物溯源、需求 → AC → 用例 → 证据 → 判决的追溯图。
- **上下文可视化**：每个节点注入了什么、多少 token、什么时候压缩、丢了什么。
- **多 harness × 多模型**：Claude Code、Codex、DeepSeek Harness 按角色和节点选择，可降级。
- **流程即代码，画布可视化**：TypeScript 定义 DAG，Web 上实时看运行状态和每个节点的细节。

## 快速开始

```bash
npm install
npm run build
npm run demo            # 用 mock harness 跑示例需求：失败 → 判决 → 修复 → 通过
npm run takt -- serve --project examples/hello-delivery   # 打开 Web 控制台（默认 http://127.0.0.1:4870）
npm run takt -- doctor --project examples/hello-delivery  # 检查 harness / 模型 / 插件
```

## 支持哪些 harness 和模型

| 类别 | 支持 |
|---|---|
| Agent harness（内置适配器） | Claude Code、Codex、DeepSeek Harness、Gemini CLI、Cursor Agent、Qwen Code、Kimi CLI、OpenCode、mock |
| 任意 CLI（零代码接入） | 在 `takt.config.json` 的 `harnesses` 里声明命令模板与输出映射，例如 Aider、Goose |
| 内置轻量 Agent（native） | 直连任意 LLM API；写权限在工具层前置校验，bash 默认关闭 |
| LLM API | OpenAI 兼容（OpenAI、DeepSeek、Kimi、智谱 GLM、通义千问、火山方舟、MiniMax、硅基流动、OpenRouter、Azure、Ollama、vLLM、LM Studio、LiteLLM）、Anthropic 兼容 |
| harness × 模型 | Claude Code / Codex 可以把模型指到别家 API（如 Claude Code + GLM），按角色或节点配置 |

`takt doctor` 检查每个 harness、provider、模型和插件是否可用；`takt harness ls` / `takt models ls` 查看能力矩阵。扩展方式（插件、能力声明、一致性测试）见 [docs/design/13](docs/design/13-扩展性与生态.md)。

## 定义一条流水线

```ts
import { defineWorkflow, agent, human, judge, loop, script } from '@taktflow/core'

export default defineWorkflow({
  id: 'mini', title: '最小流水线', version: '0.1.0',
  stages: [{ id: 'spec', title: '需求' }, { id: 'loop', title: '研发测试' }],
  nodes: [
    agent({ id: 'spec', title: '写 spec', stage: 'spec', role: 'pm', prompt: '…', outputs: [{ path: 'spec/spec.md', kind: 'spec' }] }),
    human({ id: 'review', title: '评审', stage: 'spec', needs: ['spec'], form: 'approve', ask: '审 spec' }),
    loop({
      id: 'dev-test', title: '研发测试 Loop', stage: 'loop', needs: ['review'], maxIterations: 5,
      until: (ctx) => (ctx.resultOf('run') as { failures: unknown[] }).failures.length === 0,
      body: [
        script({ id: 'run', title: '执行用例', run: 'npm test' }),
        judge({ id: 'judge', title: '判决', role: 'judge', needs: ['run'], target: 'run', routes: { product_bug: 'fix' } }),
        agent({ id: 'fix', title: '修复', role: 'dev', needs: ['judge'], prompt: '…' }),
      ],
    }),
  ],
})
```

完整模板见 [templates/workflows/sdlc.workflow.ts](templates/workflows/sdlc.workflow.ts)。

## 仓库结构

```
packages/core       类型契约、DSL、引擎、文件存储、读模型
packages/harness    Claude Code / Codex / DeepSeek Harness / mock 适配器
packages/knowledge  存量项目知识源与路由
packages/server     HTTP API + SSE
packages/cli        takt 命令
packages/web        Web 控制台（React + React Flow）
templates/          默认流水线与角色档案
examples/           示例项目
docs/design/        设计文档（解决什么问题、怎么做）
docs/dev/           模块开发简报
```

## License

MIT
