# M8 · Harness 外部模型 API 注入核实

范围：设计 32 §4–§5、设计 31 §2–§4，以及管家运行配置。只改相关 core、harness、server、CLI 目录字段透传和本文档；不改 web，不提交或推送。

## 实现

- `provider-injection.ts` 集中构造逐次注入。JSON 作为 YAML 子集写入临时文件，目录由 mkdtemp 创建，文件权限 0600；不写真实密钥，只有变量名。正常结束、失败、超时、取消都在 finally 清理。密钥在子进程环境中传递，不修改父进程环境。
- dsh 使用 `agent-default-model` 与 `llm-pi-ai` 两个固定插件 ID；OpenAI Chat 映射 `openai-completions`。不带 provider 时只覆盖 DeepSeek 账号的 model/effort；未给出的字段保留 profile 的默认值。`available()` 先查版本，账号短任务的失败只影响 `ownReady/ownReason`，不阻止外部 API。
- OpenCode CLI 用 `OPENCODE_CONFIG_CONTENT`，模型选择 `takt-runtime/<model>`；配置只含 `{env:TAKT_OPENCODE_API_KEY}`。配置合并顺序为用户/项目 < 本次 content < 管理策略；不绕过管理策略。
- Qwen CLI 与 ACP 共用注入：三协议的 env + `--auth-type` + `--model`；`--bare` 防止已有 modelProviders 抢先，临时 QWEN_HOME 防止 ACP 的认证/模型保存修改原用户配置。ACP 预设版本与核实源码对应到 0.27.1。
- Hermes 用 `hermes-acp`（Python console script），临时 HERMES_HOME 内的 config.yaml 选择 `custom:takt-runtime`，`providers` 中声明 base_url / key_env / chat_completions。
- Qwen / Hermes 外部 API 模式的临时目录在退出后删除，因此不支持跨调用续会话；带 sessionId 时明确拒绝，不能假装已续接。自带模式仍依据 ACP 握手能力执行。
- OpenClaw 只新增 ACP 预设。`openclaw acp` 连接已运行的 Gateway，不负责启动 Gateway；将 OPENCLAW_CONFIG_PATH 传给 ACP 子进程，不能证明另一个进程中的 models.providers 已改变。缺少隔离 Gateway 的启动、配置生效与回收验证，因此 customProvider=false。
- Claude 默认 CLI；`harnessOverrides['claude-code'].transport='acp'` 使用同一 ID 的 Claude ACP。command 覆盖预设的第一个可执行参数，env 合并规则不变；能力/可用性由 ACP 返回。自定义 Claude ACP 条目及角色引用不迁移。ACP 当前没有声明管家 MCP 能力，因此不能因 CLI 可用于管家就把 ACP 也当作可用。
- Pi 当前官方源码把裸 `apiKey` 字符串当字面量；修正为 `${ENV_NAME}`，保留临时扩展机制与四协议声明。需要使用与下述源码契约一致的 Pi 版本。
- StewardRuntime 增加 provider / effort；管家用 resolveHarnessSelector 解析别名、厂商 ID 和显式 provider。模型别名仍先解析成厂商 ID，显式 provider 覆盖别名归属；跨 provider 不沿用旧模型元数据。创建线程和 PATCH 共用校验，旧 runtime-choices 的别名列表及不可用原因仍有效。外部 harness 的请求携带 effort；native 的既有 ChatRequest 不支持 effort，不新增虚假的原生推理档能力。
- HarnessInfo 透传 ownReady / ownReason，搭配矩阵仅关闭自带格。未登录和执行器不存在分别表达。账号探测超时也标记未就绪，并保留原因，不写成“已登录”。

## 核实依据

下列 `refs/` 对应任务给定的本机只读参考源码目录。行号针对记录的提交；若安装版本不同，需重跑下节命令。

| Harness | 结论、注入方式 | 本次依据 |
|---|---|---|
| Claude Code CLI | anthropic-messages；ANTHROPIC_BASE_URL / AUTH_TOKEN / MODEL 等 | 本机 2.1.282，环回端点收到 `/v1/messages?beta=true`、模型 `probe-model`、预期认证，解析回复 OK |
| Claude Code ACP | anthropic-messages；同一环境注入 | 本机安装包 `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:9180–9207` 合并 process.env 与 providerEnv；`:9422` 调用 SDK query。核实了源码与 fake ACP 握手，未做真实 ACP 模型调用 |
| Codex | openai-responses；`-c model_providers.*`、env_key | 本机 0.159.2，环回 `/v1/responses` 主请求模型 `probe-model`，认证匹配，回复 OK；同时观察到辅助请求使用 CLI 自选模型，不能声称所有后台请求均锁定主模型 |
| TRAE CLI | openai-responses；同 Codex | 本机 0.213.1，环回 `/v1/responses`、模型及认证匹配，回复 OK |
| dsh | Chat / Responses / Anthropic；临时 --patch + apiKeyEnv | 本机 0.2.2-rc.1；dump-config-schema 的 config14 给出三协议与 apiKeyEnv；三种 --patch --dump-config 均回读到 provider / model / high；三协议环回真跑均收到正确请求并回复 OK |
| OpenCode CLI | Chat / Anthropic；运行时 JSON env、env 引用、--model | `refs/opencode/packages/cli/src/server-process.ts:133` 读取环境配置；`packages/core/src/config.ts:138–151,291–302,366–376` 解析、归一化与层次顺序；`config/variable.ts:25–38` 替换 `{env:VAR}`；`v1/config/migrate.ts:120–138` 保留 npm/options；`v1/config/provider-options.ts:37–38` 保留 apiKey/baseURL；`packages/cli/src/commands/commands.ts:392` 明确 provider/model |
| Qwen Code CLI / ACP | Chat / Responses / Anthropic；协议 env、--auth-type、临时 QWEN_HOME | `refs/qwen-code/packages/core/src/utils/auth-type.ts:8–16` 三种认证；`models/constants.ts:87–102` 环境变量；`packages/cli/src/config/config.ts:791,2311–2315,2401` 显式认证优先与 bare 配置隔离；`packages/core/src/config/storage.ts:193–202` QWEN_HOME；同一启动配置用于 ACP |
| Hermes ACP | Chat；临时 config.yaml、key_env | `refs/hermes-agent/pyproject.toml:449,595` ACP extra 与 hermes-acp 入口；`acp_adapter/entry.py:94–103` 参数；`acp_adapter/session.py:522–560` 读取默认模型并解析 provider；`hermes_constants.py:194–202` HERMES_HOME；`hermes_cli/config.py:433–435` config.yaml；`hermes_cli/runtime_provider_custom.py:150–179,738–766` 读取 base_url/key_env/api_mode 并构造 runtime |
| OpenClaw ACP | 只登记自带；无外部注入 | `refs/openclaw/docs/cli/acp.md:10–19` 说明 ACP 转发到 Gateway；`src/acp/server.ts:100–145` 构造 Gateway 客户端；`src/config/paths.ts:213–242` 虽支持 OPENCLAW_CONFIG_PATH，但不能据此认定 Gateway 使用了子进程临时模型配置 |
| Pi | Chat / Responses / Anthropic / Gemini；临时扩展和 `${ENV_NAME}` | 官方只读浅克隆 `/tmp/takt-pairing-pi-source`：`packages/coding-agent/src/core/model-registry.ts:210–215` 动态注册；`src/core/resolve-config-value.ts:139–150` 环境引用；`docs/custom-provider.md:59–63` 同样示例；`packages/ai/src/types.ts:65–72` 四协议。未安装 Pi CLI，未真跑 |
| Gemini CLI / Cursor / Copilot / Kimi / Goose | 本次保持 customProvider=false、自带 | 没有核实到满足本任务“逐次注入且不改全局配置”的路径；不根据其他工具或协议的支持推断可用 |
| native | Chat / Anthropic；进程内 | 仓库 `packages/harness/src/providers/index.ts:23–31` 仅构造这两种 provider；本次不扩展其协议 |
| mock | 无外部 API | 测试替身，不登记为可接模型 API |

源码提交：OpenCode `2a9a3ed97c8ff10d96a94b48ab3a0dde32e88f28`；Qwen `ddab42d67859f94141a7700bd7b50e14436ed0cf`；Hermes `b3746e35ddd32079697728e2df57a9d78f1e9e32`；OpenClaw `109ad1ca331e162b029f86ec860bccbb1d80e878`；Pi `2c1d24d6f4927004af7d8fda93e76586dd6097de`。

环回真跑用了本地 HTTP 模拟协议响应与合成令牌，不连接真实厂商模型服务，不证明模型质量、真实服务鉴权或计费行为。单元测试只用 fake bin / fake ACP / mock，不运行真实 CLI，也不新增模型网络请求。

## 测试索引

- `packages/harness/src/provider-injection.test.ts`：dsh 三协议 patch / 清理；OpenCode 两协议配置；Qwen CLI 与 ACP 三协议共用注入；Hermes 配置与 OpenClaw 保守能力；异常退出/启动后取消清理；缺密钥/协议拒绝；Claude 同 ID ACP 握手与默认 CLI。
- `packages/harness/src/dsh.test.ts`：原事件解析保留；自带 model/effort patch；版本与账号状态分离；缓存、ENOENT 回退、账号超时与未登录。
- `packages/harness/src/pairing-adapters.test.ts`：Pi 四协议扩展的环境引用、密钥不进文件、清理；Codex/TRAE 既有参数与脱敏。
- `packages/harness/src/adapters/{existing-providers,stream-cli}.test.ts`、`index.test.ts`、`acp/acp.test.ts`：能力和预设的新契约。
- `packages/core/src/runtime-config/runtime-config.test.ts`：仅 Claude 接受 cli/acp，拒绝未知接法/其他 harness 的 transport。
- `packages/core/src/steward/runtime.test.ts`：provider/effort 格式、原始模型、旧 choices 兼容、错误透传。
- `packages/server/src/steward-runtime.test.ts`：原始模型/别名/显式 provider/effort、缺失 provider、自带账号与 API 分离，原桥接与 MCP 测试保留。
- `packages/server/src/pairing-test.test.ts`：ownReady=false 时仅自带格不可用。

验收命令（按包顺序运行；harness 限制测试工作进程数，避免本机负载影响已有短时序测试）：

```sh
npx vitest run packages/harness --maxWorkers=2 --minWorkers=1
npx vitest run packages/core
npx vitest run packages/server
npm run typecheck
```

最终检查（2026-11-10）：harness 40 个文件通过，867 项通过、2 项 Linux 平台专属跳过；core 101 个文件、977 项通过；server 25 个文件、176 项通过；npm run typecheck 和 git diff --check 均通过。此前默认并发运行触发过既有短时序测试超时，最终 harness 限制为 2 个测试工作进程，未删减测试范围。

## 安装后手动真跑

本次未安装、升级或自动下载任何 CLI。先按各项目说明安装与以上源码契约匹配的版本：OpenCode；Qwen 0.27.1（ACP 预设使用 `npx --no-install`）；Hermes 安装源码目录中的 `.[acp]` extra 并执行 `hermes-acp --check`；Pi；OpenClaw。OpenClaw 还须由使用者事先配置并启动 Gateway。Claude ACP 使用预设中的 0.101.0，本次不修改用户已有条目。

以下函数通过本仓库适配器执行最小任务，能同时验收生成参数和 CLI 的真实行为。先在密钥管理工具或安全终端环境中准备 `TAKT_VERIFY_API_KEY`，不要把值写进文件或命令行参数。示例地址和模型名必须替换。

```sh
npm run typecheck
export TAKT_VERIFY_BASE_URL='https://provider.example/v1'
export TAKT_VERIFY_MODEL='vendor-model-id'
# TAKT_VERIFY_API_KEY 已由当前进程环境安全注入；这里不显示、赋值或打印密钥。
verify_harness() {
  TAKT_VERIFY_HARNESS="$1" TAKT_VERIFY_PROTOCOL="$2" node --input-type=module <<'JS'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarnesses, createAcpHarness, createRedactor } from './packages/harness/dist/index.js'
const id = process.env.TAKT_VERIFY_HARNESS
const protocol = process.env.TAKT_VERIFY_PROTOCOL
const own = protocol === 'own'
const harness = id.startsWith('acp-')
  ? createAcpHarness({ id, kind: 'acp', preset: id.slice(4) })
  : createHarnesses()[id]
if (!harness) throw new Error('未知 harness')
if (!own && !process.env.TAKT_VERIFY_API_KEY) throw new Error('请先安全注入 TAKT_VERIFY_API_KEY')
const cwd = await mkdtemp(join(tmpdir(), 'takt-manual-provider-'))
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
try {
  const result = await harness.run({ cwd, prompt: 'Reply only OK. Do not use tools.',
    ...(own ? {} : { model: process.env.TAKT_VERIFY_MODEL,
      provider: { id: 'verify', protocol, baseURL: process.env.TAKT_VERIFY_BASE_URL, apiKeyEnv: 'TAKT_VERIFY_API_KEY' } }),
    signal: controller.signal, timeoutMs: 120000,
  }, () => {})
  const redact = createRedactor([process.env.TAKT_VERIFY_API_KEY ?? ''].filter(Boolean))
  console.log(redact(JSON.stringify({ ok: result.ok, text: result.finalText, error: result.error })))
  if (!result.ok || result.finalText.trim() !== 'OK') process.exitCode = 1
} finally { await rm(cwd, { recursive: true, force: true }) }
JS
}

# Chat 端点（通常带 /v1）
verify_harness dsh openai-chat
verify_harness opencode openai-chat
verify_harness qwen-code openai-chat
verify_harness acp-qwen openai-chat
verify_harness acp-hermes openai-chat
verify_harness pi openai-chat

# Responses 端点（通常带 /v1）
verify_harness dsh openai-responses
verify_harness codex openai-responses
verify_harness trae openai-responses
verify_harness qwen-code openai-responses
verify_harness acp-qwen openai-responses
verify_harness pi openai-responses

# 改成该厂商实际的 Anthropic 协议根地址
export TAKT_VERIFY_BASE_URL='https://provider.example/anthropic'
verify_harness claude-code anthropic-messages
verify_harness acp-claude anthropic-messages
verify_harness dsh anthropic-messages
verify_harness opencode anthropic-messages
verify_harness qwen-code anthropic-messages
verify_harness acp-qwen anthropic-messages
verify_harness pi anthropic-messages

# Pi 的 Gemini 兼容端点；同样需要该协议下真实有效的模型 ID
export TAKT_VERIFY_BASE_URL='https://provider.example'
verify_harness pi gemini

# OpenClaw 只验收使用已运行 Gateway 的自带路径
verify_harness acp-openclaw own
```

只核对 dsh 配置合并、不发模型请求时：

```sh
(
  patch_file=$(mktemp)
  trap 'rm -f "$patch_file"' EXIT
  cat > "$patch_file" <<'JSON'
[
  {"id":"llm-pi-ai","name":"@deepseek-ai/dsh-llm-pi-ai","config":{"providers":{"verify":{"api":"openai-completions","baseURL":"https://provider.example/v1","apiKeyEnv":"TAKT_VERIFY_API_KEY","models":[{"id":"vendor-model-id"}]}}}},
  {"id":"agent-default-model","name":"@deepseek-ai/dsh-agent-default-model","config":{"provider":"verify","model":"vendor-model-id","reasoningEffort":"high"}}
]
JSON
  dsh --profile headless --patch "$patch_file" --dump-config
)
```

这里的 dump-config 会输出用户原有配置；检查时不要将未脱敏的完整输出发布到报告。密钥字段保持 apiKeyEnv，不能改成明文。

## 交付边界

- 本次已按任务授权修改协议，不再提出待审批的协议变更请求。
- 未做前端、模型发现、真实厂商端到端验收、OpenClaw 独立 Gateway 生命周期、Gemini/Cursor/Copilot/Kimi/Goose 的新注入。
- API 模式中 Qwen 的 bare 和 Hermes 临时 home 不加载个人工具配置；这是避免既有 provider 和认证配置覆盖本次请求的必要行为。需要个人扩展/MCP 的场景须单独验证。

## 本次文件清单

- `docs/design/13-扩展性与生态.md`
- `docs/design/32-Harness目录模型发现与选择器.md`
- `docs/dev/m8-pairing-verify.md`
- `packages/cli/src/catalog.ts`
- `packages/core/src/api.ts`
- `packages/core/src/runtime-config/runtime-config.test.ts`
- `packages/core/src/runtime-config/validation.ts`
- `packages/core/src/steward/runtime.test.ts`
- `packages/core/src/steward/runtime.ts`
- `packages/core/src/types.ts`
- `packages/harness/src/acp/acp.test.ts`
- `packages/harness/src/acp/index.ts`
- `packages/harness/src/acp/presets.ts`
- `packages/harness/src/adapters/existing-providers.test.ts`
- `packages/harness/src/adapters/opencode.ts`
- `packages/harness/src/adapters/pi.ts`
- `packages/harness/src/adapters/qwen-code.ts`
- `packages/harness/src/adapters/stream-cli.test.ts`
- `packages/harness/src/adapters/stream-cli.ts`
- `packages/harness/src/catalog-info.ts`
- `packages/harness/src/dsh.test.ts`
- `packages/harness/src/dsh.ts`
- `packages/harness/src/index.test.ts`
- `packages/harness/src/index.ts`
- `packages/harness/src/pairing-adapters.test.ts`
- `packages/harness/src/provider-injection.test.ts`
- `packages/harness/src/provider-injection.ts`
- `packages/server/src/pairing-test.test.ts`
- `packages/server/src/pairings.ts`
- `packages/server/src/runtime-catalog.ts`
- `packages/server/src/steward-runtime.test.ts`
- `packages/server/src/steward-runtime.ts`
