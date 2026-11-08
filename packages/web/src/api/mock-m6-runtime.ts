/**
 * 设置页「模型与 Harness」的演示数据与写接口（docs/design/27 §4）。
 * 目录（harnesses / models）由这份运行配置推出来，改了配置马上反映到卡片与模型表上。
 */
import type {
  AcpHarnessConfig,
  CliHarnessConfig,
  HarnessCapabilities,
  HarnessInfo,
  HarnessSelector,
  ModelInfo,
  RuntimeConfig,
  RuntimeConfigPatch,
  RuntimeSystemRole,
  RuntimeTestResult,
  SecretSource,
} from '@taktflow/core'
import { RuntimeConflictError, type M6Source } from './source-m6'

const MASK = '[REDACTED]'
const ALL: HarnessCapabilities = { resume: true, structuredOutput: true, toolEvents: true, usage: true, cost: true, compactionEvents: true, customProvider: true, sandbox: true, mcp: true }

interface Builtin {
  id: string
  displayName: string
  source: HarnessInfo['source']
  command?: string[]
  capabilities: HarnessCapabilities
  /** 演示：本机探测结果（停用优先于探测）。 */
  probe: { ok: true; detail: string } | { ok: false; reason: string }
}

const BUILTINS: Builtin[] = [
  { id: 'claude-code', displayName: 'Claude Code', source: 'builtin', command: ['claude'], capabilities: ALL, probe: { ok: true, detail: 'claude 2.4.1 · stream-json' } },
  { id: 'codex', displayName: 'Codex', source: 'builtin', command: ['codex'], capabilities: { ...ALL, cost: false, compactionEvents: false }, probe: { ok: true, detail: 'codex-cli 0.98.0 · exec --json' } },
  { id: 'native', displayName: 'takt native', source: 'native', capabilities: { ...ALL, customProvider: false }, probe: { ok: true, detail: '内置：直接调用 provider 的 HTTP 接口' } },
  {
    id: 'dsh', displayName: 'DeepSeek Harness', source: 'builtin', command: ['dsh'],
    capabilities: { resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: false, compactionEvents: true, customProvider: false, sandbox: true, mcp: false },
    probe: { ok: false, reason: '需要登录：dsh 未找到有效会话，先在终端运行 dsh login' },
  },
  {
    id: 'gemini-cli', displayName: 'Gemini CLI', source: 'builtin', command: ['gemini'],
    capabilities: { resume: false, structuredOutput: false, toolEvents: true, usage: true, cost: false, compactionEvents: false, customProvider: false, sandbox: true, mcp: true },
    probe: { ok: false, reason: '未安装：PATH 中找不到 gemini（npm i -g @google/gemini-cli）' },
  },
]

const ACP_PRESETS: RuntimeConfig['presets']['acp'] = [
  { id: 'gemini', displayName: 'Gemini CLI', command: ['npx', '--no-install', '@google/gemini-cli@0.67.0', '--acp'], install: 'npm install -g @google/gemini-cli@0.67.0；先完成 Gemini 登录' },
  { id: 'claude', displayName: 'Claude Agent ACP', command: ['npx', '--no-install', '@agentclientprotocol/claude-agent-acp@0.101.0'], install: 'npm install -g @agentclientprotocol/claude-agent-acp@0.101.0；按项目文档配置认证' },
  { id: 'codex', displayName: 'Codex ACP', command: ['npx', '--no-install', '@agentclientprotocol/codex-acp@2.5.0'], install: 'npm install -g @agentclientprotocol/codex-acp@2.5.0；先完成 Codex 登录' },
  { id: 'opencode', displayName: 'OpenCode', command: ['opencode', 'acp'], install: '从 OpenCode 的发布页安装适合本机的二进制并加入 PATH（核对版本 2.2.6）' },
  { id: 'qwen', displayName: 'Qwen Code', command: ['npx', '--no-install', '@qwen-code/qwen-code@0.27.0', '--acp', '--experimental-skills'], install: 'npm install -g @qwen-code/qwen-code@0.27.0；先完成 Qwen 登录' },
  { id: 'kimi', displayName: 'Kimi CLI（Legacy）', command: ['kimi', 'acp'], install: '安装 Kimi CLI 1.52.0 对应二进制并加入 PATH；官方已归档，新用户可自定义 Kimi Code 命令' },
  { id: 'goose', displayName: 'Goose', command: ['goose', 'acp'], install: '从 Goose 的发布页安装适合本机的二进制并加入 PATH（核对版本 1.57.0）' },
  { id: 'copilot', displayName: 'GitHub Copilot', command: ['npx', '--no-install', '@github/copilot@1.0.107', '--acp'], install: 'npm install -g @github/copilot@1.0.107；先完成 GitHub 登录' },
]

const PROVIDER_PRESETS: RuntimeConfig['presets']['providers'] = [
  { id: 'openai', displayName: 'OpenAI', protocol: 'openai-chat', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  { id: 'anthropic', displayName: 'Anthropic', protocol: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'deepseek', displayName: 'DeepSeek', protocol: 'openai-chat', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'moonshot', displayName: 'Moonshot', protocol: 'openai-chat', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
  { id: 'zhipu', displayName: '智谱', protocol: 'openai-chat', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY' },
  { id: 'dashscope', displayName: '阿里百炼', protocol: 'openai-chat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  { id: 'ark', displayName: '火山方舟', protocol: 'openai-chat', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'ARK_API_KEY' },
  { id: 'minimax', displayName: 'MiniMax', protocol: 'openai-chat', apiKeyEnv: 'MINIMAX_API_KEY' },
  { id: 'siliconflow', displayName: '硅基流动', protocol: 'openai-chat', baseURL: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY' },
  { id: 'openrouter', displayName: 'OpenRouter', protocol: 'openai-chat', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  { id: 'azure-openai', displayName: 'Azure OpenAI', protocol: 'openai-chat', apiKeyEnv: 'AZURE_OPENAI_API_KEY' },
  { id: 'ollama', displayName: 'Ollama', protocol: 'openai-chat', baseURL: 'http://localhost:11434/v1' },
  { id: 'vllm', displayName: 'vLLM', protocol: 'openai-chat' },
  { id: 'lmstudio', displayName: 'LM Studio', protocol: 'openai-chat', baseURL: 'http://localhost:1234/v1' },
  { id: 'litellm', displayName: 'LiteLLM', protocol: 'openai-chat' },
]

/** 演示：启动 serve 的终端里设了哪些环境变量（真实环境由服务端判断，不回传值）。 */
const ENV = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY'])

function seed(seeded: boolean): Omit<RuntimeConfig, 'revision' | 'keys' | 'presets'> & { local: Set<string> } {
  if (!seeded) return { providers: {}, models: {}, roles: {}, system: {}, harnesses: [], harnessOverrides: {}, local: new Set() }
  const sonnet: HarnessSelector = { harness: 'claude-code', model: 'sonnet' }
  return {
    providers: {
      anthropic: { preset: 'anthropic', protocol: 'anthropic-messages', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      openai: { preset: 'openai', protocol: 'openai-responses', apiKeyEnv: 'OPENAI_API_KEY' },
      deepseek: { preset: 'deepseek', protocol: 'openai-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      'deepseek-anthropic': { protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      glm: { protocol: 'anthropic-messages', baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKeyEnv: 'ZHIPU_API_KEY' },
      dashscope: { preset: 'dashscope', protocol: 'openai-chat', apiKeyEnv: 'DASHSCOPE_API_KEY' },
      moonshot: { preset: 'moonshot', protocol: 'openai-chat', apiKeyEnv: 'MOONSHOT_API_KEY' },
      ark: { preset: 'ark', protocol: 'openai-chat', apiKeyEnv: 'ARK_API_KEY' },
      ollama: { preset: 'ollama', protocol: 'openai-chat' },
    },
    models: {
      sonnet: { provider: 'anthropic', id: 'claude-sonnet-4-5', contextWindow: 200_000, price: { input: 3, output: 15 } },
      'gpt-5-codex': { provider: 'openai', id: 'gpt-5-codex', contextWindow: 400_000, price: { input: 1.25, output: 10 } },
      'deepseek-v4': { provider: 'deepseek', id: 'deepseek-chat', contextWindow: 128_000, price: { input: 0.28, output: 0.42 } },
      'deepseek-cc': { provider: 'deepseek-anthropic', id: 'deepseek-chat', contextWindow: 128_000, price: { input: 0.28, output: 0.42 } },
      'glm-5': { provider: 'glm', id: 'glm-5', contextWindow: 200_000, price: { input: 0.6, output: 2.2 } },
      'qwen3-coder': { provider: 'dashscope', id: 'qwen3-coder-plus', contextWindow: 1_000_000, price: { input: 1, output: 5 } },
      'kimi-k2': { provider: 'moonshot', id: 'kimi-k2-turbo-preview', contextWindow: 256_000, price: { input: 0.6, output: 2.5 } },
      'doubao-seed': { provider: 'ark', id: 'doubao-seed-1-6', contextWindow: 256_000 },
      'local-coder': { provider: 'ollama', id: 'qwen2.5-coder:32b', contextWindow: 32_768, price: { input: 0, output: 0 } },
      'embed-small': { provider: 'openai', id: 'text-embedding-3-small', kind: 'embedding', dimensions: 1536, price: { input: 0.02, output: 0 } },
    },
    roles: {
      pm: sonnet,
      architect: sonnet,
      reviewer: { ...sonnet, effort: 'high' },
      judge: { ...sonnet, effort: 'high' },
      dev: { harness: 'codex', model: 'gpt-5-codex', effort: 'high', fallback: [sonnet] },
      automation: { harness: 'codex', model: 'gpt-5-codex' },
      'test-designer': { harness: 'codex', model: 'gpt-5-codex', fallback: [{ harness: 'opencode-acp', model: 'kimi-k2' }] },
    },
    system: {
      lead: sonnet,
      route: { harness: 'native', model: 'deepseek-v4' },
      steward: sonnet,
      learner: { harness: 'native', model: 'kimi-k2' },
    },
    harnesses: [
      { id: 'opencode-acp', kind: 'acp', preset: 'opencode', displayName: 'OpenCode（ACP）', permissions: 'allow' },
      { id: 'aider', kind: 'cli', displayName: 'Aider', command: ['aider', '--message', '{{prompt}}', '--yes-always', '--no-pretty'], promptVia: 'arg', output: { format: 'text' } },
    ],
    harnessOverrides: { 'gemini-cli': { disabled: true } },
    local: new Set(['DEEPSEEK_API_KEY', 'ARK_API_KEY']),
  }
}

const ACP_CAPS: HarnessCapabilities = { resume: true, structuredOutput: false, toolEvents: true, usage: false, cost: false, compactionEvents: false, customProvider: false, sandbox: false, mcp: false }

/** 演示：哪些 ACP 预设在这台机器上能握手（其它的报"命令不存在"）。 */
const ACP_INSTALLED = new Set(['opencode', 'claude', 'codex', 'goose'])

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

const SYSTEM_ROLES: RuntimeSystemRole[] = ['lead', 'route', 'steward', 'learner']
/** 真实注册表里的全部内置 id（演示只列出其中 5 个），自定义的不能重名。 */
const BUILTIN_IDS = new Set(['native', 'mock', 'claude-code', 'codex', 'dsh', 'gemini-cli', 'cursor-agent', 'qwen-code', 'kimi-cli', 'opencode', 'pi'])

export interface MockRuntime extends M6Source {
  harnesses(): HarnessInfo[]
  models(): ModelInfo[]
}

export function createMockRuntime(seeded: boolean): MockRuntime {
  const s = seed(seeded)
  const clone = <T,>(v: T): T => structuredClone(v)
  const delay = <T,>(v: T, ms = 160): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
  const fail = (msg: string, ms = 160): Promise<never> => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))

  const sourceOf = (name: string): SecretSource => (ENV.has(name) ? 'env' : s.local.has(name) ? 'local' : 'missing')
  const body = () => ({ providers: s.providers, models: s.models, roles: s.roles, system: s.system, harnesses: s.harnesses, harnessOverrides: s.harnessOverrides })
  const view = (): RuntimeConfig => {
    const keys: Record<string, SecretSource> = {}
    for (const p of Object.values(s.providers)) if (p.apiKeyEnv) keys[p.apiKeyEnv] = sourceOf(p.apiKeyEnv)
    const b = clone(body())
    // 环境变量值可能是密钥：只回名字（值遮盖），原样提交表示不改
    const mask = (env?: Record<string, string>) => (env ? Object.fromEntries(Object.keys(env).map((k) => [k, MASK])) : undefined)
    for (const o of Object.values(b.harnessOverrides)) if (o.env) o.env = mask(o.env)
    for (const h of b.harnesses) if (h.env) h.env = mask(h.env)
    return { revision: hash(JSON.stringify(body())), ...b, keys, presets: { providers: PROVIDER_PRESETS, acp: ACP_PRESETS } }
  }

  const rolesOf = (id: string) => Object.entries(s.roles).filter(([, sel]) => sel.harness === id).map(([r]) => r).sort()
  const acpCommand = (h: AcpHarnessConfig) => h.command ?? ACP_PRESETS.find((p) => p.id === h.preset)?.command ?? []
  const probe = (id: string): { ok: boolean; reason?: string; detail?: string } => {
    if (s.harnessOverrides[id]?.disabled) return { ok: false, reason: '本空间已停用' }
    const b = BUILTINS.find((x) => x.id === id)
    if (b) {
      // 设了可执行文件路径：演示里 ~/ 或绝对路径算找得到
      const cmd = s.harnessOverrides[id]?.command
      if (cmd && b.probe.ok === false && /^(~\/|\/)/.test(cmd)) return { ok: true, detail: `${cmd} · 手动指定路径` }
      return b.probe.ok ? { ok: true, detail: b.probe.detail } : { ok: false, reason: b.probe.reason }
    }
    const c = s.harnesses.find((x) => x.id === id)
    if (!c) return { ok: false, reason: `harness ${id} 不存在` }
    if (c.kind === 'cli') return c.command[0] === 'aider' ? { ok: true, detail: 'aider 0.86.1 · 纯文本输出（没有工具事件与用量）' } : { ok: false, reason: `未找到命令 ${c.command[0]}：未安装或不在 PATH 中` }
    const bin = acpCommand(c)
    const preset = c.preset && ACP_INSTALLED.has(c.preset)
    if (!preset && !(bin[0] && /^(~\/|\/)/.test(bin[0]))) return { ok: false, reason: `ACP 握手失败：未找到命令 ${bin[2] ?? bin[0] ?? '?'}；先按预设的安装说明装好，再测试` }
    const name = ACP_PRESETS.find((p) => p.id === c.preset)?.displayName ?? c.displayName ?? c.id
    return { ok: true, detail: JSON.stringify({ name, version: c.preset === 'opencode' ? '2.2.6' : '1.0.0', protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } } }) }
  }

  const harnesses = (): HarnessInfo[] => {
    const out: HarnessInfo[] = BUILTINS.map((b) => {
      const o = s.harnessOverrides[b.id]
      const p = probe(b.id)
      return {
        id: b.id, displayName: b.displayName, source: b.source, available: p.ok, ...(p.reason ? { reason: p.reason } : {}),
        capabilities: b.capabilities, roles: rolesOf(b.id), custom: false,
        ...(b.command ? { command: o?.command ? [o.command] : b.command } : {}),
        ...(o ? { override: { ...o, ...(o.env ? { env: Object.fromEntries(Object.keys(o.env).map((k) => [k, MASK])) } : {}) } } : {}),
      }
    })
    for (const c of s.harnesses) {
      const p = probe(c.id)
      out.push({
        id: c.id, displayName: c.displayName ?? c.id, source: c.kind, available: p.ok, ...(p.reason ? { reason: p.reason } : {}),
        capabilities: c.kind === 'acp' ? ACP_CAPS : {}, roles: rolesOf(c.id), custom: true,
        command: c.kind === 'acp' ? acpCommand(c) : c.command,
      })
    }
    return out
  }

  const models = (): ModelInfo[] =>
    Object.entries(s.models).map(([alias, m]) => {
      const p = s.providers[m.provider]
      return {
        alias, provider: m.provider, protocol: p?.protocol ?? '?', id: m.id,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.price ? { price: { input: m.price.input, output: m.price.output } } : {}),
        keyPresent: !p?.apiKeyEnv || sourceOf(p.apiKeyEnv) !== 'missing', kind: m.kind ?? 'chat',
      }
    })

  /** 和服务端同一套校验口径：哪个字段错、下一步怎么办。 */
  function validate(next: ReturnType<typeof body>): string | undefined {
    for (const [alias, m] of Object.entries(next.models)) {
      if (!next.providers[m.provider]) return `模型 ${alias} 指向不存在的 provider ${m.provider}：先加这个 provider，或把模型改到已有的 provider`
      if (m.kind === 'embedding' && !m.dimensions) return `向量模型 ${alias} 缺少维度：填上 dimensions（例如 1536）`
    }
    const ids = new Set([...BUILTIN_IDS, ...next.harnesses.map((h) => h.id)])
    const check = (where: string, sel: HarnessSelector | undefined): string | undefined => {
      if (!sel) return
      if (!ids.has(sel.harness)) return `${where} 用的 harness ${sel.harness} 不存在：换一个，或先添加它`
      if (next.harnessOverrides[sel.harness]?.disabled) return `${where} 用的 harness ${sel.harness} 已停用：换一个，或先重新启用`
      if (sel.model && !next.models[sel.model] && sel.harness === 'native') return `${where} 用的模型 ${sel.model} 不在模型别名里：native 只能用已配置的别名`
      for (const f of sel.fallback ?? []) {
        const e = check(`${where} 的备选`, f)
        if (e) return e
      }
    }
    for (const [role, sel] of Object.entries(next.roles)) {
      const e = check(`角色 ${role}`, sel)
      if (e) return e
    }
    for (const r of SYSTEM_ROLES) {
      const e = check(`系统角色 ${r}`, next.system[r])
      if (e) return e
    }
    const seen = new Set<string>()
    for (const h of next.harnesses) {
      if (BUILTIN_IDS.has(h.id)) return `自定义 harness ${h.id} 与内置的同名：换一个 id`
      if (seen.has(h.id)) return `harness ${h.id} 重复：换一个 id`
      seen.add(h.id)
      if (h.kind === 'acp' && !h.preset && !h.command?.length) return `ACP harness ${h.id} 既没选预设也没填命令：二选一`
      if (h.kind === 'cli' && !h.command.length) return `CLI harness ${h.id} 缺少命令`
    }
  }

  function apply<T>(cur: Record<string, T>, patch: Record<string, T | null> | undefined): Record<string, T> {
    if (!patch) return cur
    const out = { ...cur }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete out[k]
      else out[k] = v
    }
    return out
  }

  return {
    harnesses,
    models,
    runtimeConfig: () => delay(view(), 180),
    patchRuntime(patch: RuntimeConfigPatch) {
      if (!patch.reason?.trim()) return fail('需要写原因')
      if (patch.baseRevision !== view().revision) return Promise.reject(new RuntimeConflictError('运行配置刚被别人改过：重新载入后再改'))
      const cur = body()
      const list = Object.fromEntries(cur.harnesses.map((h) => [h.id, h])) as Record<string, CliHarnessConfig | AcpHarnessConfig>
      const next = {
        providers: apply(cur.providers, patch.providers),
        models: apply(cur.models, patch.models),
        roles: apply(cur.roles, patch.roles),
        system: apply(cur.system as Record<string, HarnessSelector>, patch.system as Record<string, HarnessSelector | null> | undefined),
        harnesses: Object.values(apply(list, patch.harnesses)),
        harnessOverrides: apply(cur.harnessOverrides, patch.harnessOverrides),
      }
      // 遮盖过的环境变量值原样回来时保留旧值（界面只知道名字）
      for (const [id, o] of Object.entries(next.harnessOverrides)) {
        if (!o.env) continue
        const old = cur.harnessOverrides[id]?.env ?? {}
        next.harnessOverrides[id] = { ...o, env: Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, v === MASK ? old[k] ?? '' : v])) }
      }
      for (const h of next.harnesses) {
        if (!h.env) continue
        const old = cur.harnesses.find((x) => x.id === h.id)?.env ?? {}
        h.env = Object.fromEntries(Object.entries(h.env).map(([k, v]) => [k, v === MASK ? old[k] ?? '' : v]))
      }
      for (const [section, list] of [['harnessOverrides', Object.entries(patch.harnessOverrides ?? {})], ['harnesses', Object.entries(patch.harnesses ?? {})]] as const)
        for (const [id, v] of list)
          for (const [k, val] of Object.entries(v?.env ?? {}))
            if (val !== MASK && /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE)/i.test(k))
              return fail(`${section}.${id}.env.${k}：密钥不能写入空间配置，请使用进程环境变量或本机密钥库`)
      const bad = validate(next)
      if (bad) return fail(bad, 220)
      Object.assign(s, next)
      return delay(view(), 260)
    },
    testRuntime({ target, allowBilled }) {
      const t0 = 180
      if (target.kind === 'provider') {
        const p = s.providers[target.id]
        if (!p) return fail(`provider ${target.id} 不存在`)
        if (p.apiKeyEnv && sourceOf(p.apiKeyEnv) === 'missing')
          return delay<RuntimeTestResult>({ ok: false, message: `缺少密钥 ${p.apiKeyEnv}：存到本机密钥库，或在启动 serve 的终端里设置这个环境变量`, billed: false }, t0)
        if (target.id === 'ollama') return delay<RuntimeTestResult>({ ok: false, message: '连不上 http://localhost:11434/v1：Ollama 没在运行？先在本机启动它', latencyMs: 12, billed: false }, t0)
        const n = Object.values(s.models).filter((m) => m.provider === target.id).length
        return delay<RuntimeTestResult>({ ok: true, message: `连通：列出 ${n * 7 + 5} 个模型`, latencyMs: 240 + n * 37, detail: `已配置的别名 ${n} 个都在列表里`, billed: false }, 520)
      }
      if (target.kind === 'model') {
        const m = s.models[target.alias]
        if (!m) return fail(`模型 ${target.alias} 不存在`)
        if (!allowBilled) return fail('模型测试会发一次 1 token 的计费请求：勾选「允许一次最小计费请求」后再试')
        const p = s.providers[m.provider]
        if (p?.apiKeyEnv && sourceOf(p.apiKeyEnv) === 'missing') return delay<RuntimeTestResult>({ ok: false, message: `缺少密钥 ${p.apiKeyEnv}，没有发出请求`, billed: false }, t0)
        return delay<RuntimeTestResult>({ ok: true, message: `${m.id} 回复正常`, latencyMs: 610, detail: '输入 9 token · 输出 1 token', billed: true }, 760)
      }
      const p = probe(target.id)
      return delay<RuntimeTestResult>(p.ok ? { ok: true, message: '可用', latencyMs: 380, detail: p.detail, billed: false } : { ok: false, message: p.reason ?? '不可用', billed: false }, 640)
    },
    putSecret(name, value, reason) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return fail('密钥名只能是环境变量格式（大写字母、数字、下划线）')
      if (!value.trim()) return fail('密钥值不能为空')
      if (!reason.trim()) return fail('需要写原因')
      s.local.add(name)
      return delay({ name, source: sourceOf(name) }, 220)
    },
    deleteSecret(name, reason) {
      if (!reason.trim()) return fail('需要写原因')
      s.local.delete(name)
      return delay({ name, source: sourceOf(name) }, 200)
    },
  }
}

