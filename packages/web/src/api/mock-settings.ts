/**
 * 设置页演示数据：贴近 `takt harness ls` / `takt models ls` 在一台典型开发机上的输出。
 * 角色分配和运行演示数据（mock-data.ts 的 HARNESS 表）保持一致；价格是每百万 token 美元，仅作演示。
 */
import type { HarnessCapabilities, HarnessInfo, ModelInfo } from '@taktflow/core'

const ALL: HarnessCapabilities = { resume: true, structuredOutput: true, toolEvents: true, usage: true, cost: true, compactionEvents: true, customProvider: true, sandbox: true, mcp: true }

export const MOCK_HARNESSES: HarnessInfo[] = [
  { id: 'claude-code', displayName: 'Claude Code', source: 'builtin', available: true, capabilities: ALL, roles: ['pm', 'architect', 'reviewer', 'judge'] },
  { id: 'codex', displayName: 'Codex', source: 'builtin', available: true, capabilities: { ...ALL, cost: false, compactionEvents: false }, roles: ['dev', 'automation', 'test-designer'] },
  {
    id: 'native', displayName: 'takt native', source: 'native', available: true,
    capabilities: { ...ALL, customProvider: false },
    roles: [],
  },
  {
    id: 'dsh', displayName: 'DeepSeek Harness', source: 'builtin', available: false, reason: '需要登录：dsh 未找到有效会话，先在终端运行 dsh login',
    capabilities: { resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: false, compactionEvents: true, customProvider: false, sandbox: true, mcp: false },
    roles: [],
  },
  {
    id: 'gemini-cli', displayName: 'Gemini CLI', source: 'builtin', available: false, reason: '未安装：PATH 中找不到 gemini（npm i -g @google/gemini-cli）',
    capabilities: { resume: false, structuredOutput: false, toolEvents: true, usage: true, cost: false, compactionEvents: false, customProvider: false, sandbox: true, mcp: true },
    roles: [],
  },
  { id: 'aider', displayName: 'Aider', source: 'cli', available: true, capabilities: {}, roles: [] },
]

export const MOCK_MODELS: ModelInfo[] = [
  { alias: 'sonnet', provider: 'anthropic', protocol: 'anthropic-messages', id: 'claude-sonnet-4-5', contextWindow: 200_000, price: { input: 3, output: 15 }, keyPresent: true },
  { alias: 'gpt-5-codex', provider: 'openai', protocol: 'openai-responses', id: 'gpt-5-codex', contextWindow: 400_000, price: { input: 1.25, output: 10 }, keyPresent: true },
  { alias: 'deepseek-v4', provider: 'deepseek', protocol: 'openai-chat', id: 'deepseek-chat', contextWindow: 128_000, price: { input: 0.28, output: 0.42 }, keyPresent: true },
  { alias: 'deepseek-cc', provider: 'deepseek-anthropic', protocol: 'anthropic-messages', id: 'deepseek-chat', contextWindow: 128_000, price: { input: 0.28, output: 0.42 }, keyPresent: true },
  { alias: 'glm-5', provider: 'glm', protocol: 'anthropic-messages', id: 'glm-5', contextWindow: 200_000, price: { input: 0.6, output: 2.2 }, keyPresent: false },
  { alias: 'qwen3-coder', provider: 'dashscope', protocol: 'openai-chat', id: 'qwen3-coder-plus', contextWindow: 1_000_000, price: { input: 1, output: 5 }, keyPresent: false },
  { alias: 'kimi-k2', provider: 'moonshot', protocol: 'openai-chat', id: 'kimi-k2-turbo-preview', contextWindow: 256_000, price: { input: 0.6, output: 2.5 }, keyPresent: true },
  { alias: 'doubao-seed', provider: 'ark', protocol: 'openai-chat', id: 'doubao-seed-1-6', contextWindow: 256_000, keyPresent: true },
  { alias: 'local-coder', provider: 'ollama', protocol: 'openai-chat', id: 'qwen2.5-coder:32b', contextWindow: 32_768, price: { input: 0, output: 0 }, keyPresent: true },
]
