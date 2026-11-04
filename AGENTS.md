# AGENTS.md：给在本仓库工作的编码 Agent

## 先读

1. `docs/design/README.md`：设计总览，每个模块解决什么问题；
2. `packages/core/src/types.ts`、`interfaces.ts`、`api.ts`：**协议**。所有包只通过这些类型协作；
3. 你负责模块的开发简报：`docs/dev/<module>.md`。

## 硬规则

- **只改你负责的目录。** 简报里写了负责范围，越界的改动会被还原。需要改协议（`packages/core/src/types.ts / interfaces.ts / api.ts`）时不要直接改，在交付说明里写"协议变更请求"，说明原因和建议。
- **不要运行 `npm install` 或修改依赖**，除非简报明确允许（web 包例外）。需要的依赖都已预装：`yaml`（core）、`tsx`（cli）、`vitest`、`typescript`、`@types/node`；web 有 react、react-dom、@xyflow/react、lucide-react、vite。
- **不要提交 git，不要推送。** 由调度方统一提交。
- TypeScript strict、ESM（`.js` 后缀导入）、Node ≥ 20；只用 Node 内置模块 + 已预装依赖。
- 单测用 vitest，放在 `src/**/*.test.ts`，测试用临时目录（`os.tmpdir()`），不写仓库目录。

## 代码风格

- 和现有代码保持一致：中文注释，只在"为什么"不显然时写注释；不写空洞的 JSDoc。
- 小函数、早返回；不写无意义的防御性代码（类型已经保证的不再判空）；错误要么处理，要么抛出带上下文的 Error。
- 不重复造轮子：先看 core 里有没有现成的函数（存储、哈希、glob、token 估算），没有再写，写在最合适的位置。
- 文件名小写短横线；一个文件一个职责；导出从包的 `src/index.ts` 统一出口。

## 完成定义（每个模块通用）

- `npx tsc -b packages/<你的包>` 无错误；
- `npx vitest run packages/<你的包>` 全部通过；
- 交付说明写清：做了什么、没做什么、已知问题、协议变更请求（如有）。
