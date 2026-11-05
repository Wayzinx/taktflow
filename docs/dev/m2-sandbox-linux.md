# 开发简报：m2-sandbox-linux（沙箱、代码仓库 worktree、Linux 支持、CI 与容器）+ m2-pi（Pi 适配器）

## 任务 m2-sandbox-linux

**负责范围**：`packages/sandbox/**`（已建好空包）、`packages/harness/src/process.ts` 与 `packages/harness/src/native/**`（只做沙箱与 Linux 相关改动）、`packages/harness/src/dsh.ts`（只改可执行文件路径解析）、根目录的 `Dockerfile`、`docker-compose.yml`、`.dockerignore`、`.github/workflows/ci.yml`。不要改 `packages/harness/src/index.ts`（Pi 任务在改）和 core / server / cli / web；引擎接入在 M2-B 做。

**背景**：`docs/design/17-文件系统与沙箱.md`；协议：types.ts 的 `SandboxMount / SandboxSpec / SandboxSpawnOptions / Sandbox / SandboxProvider`、`HarnessRequest.sandbox`，interfaces.ts 的 `RepoManager`。

### 1. 沙箱提供方（packages/sandbox）
- `createLocalSandboxProvider()`：不隔离；spawn 直接 `child_process.spawn`，cwd 默认 spec.workdir，env = 进程环境中**白名单变量**（PATH、HOME、LANG、TMPDIR、SHELL、USER 等）+ spec.env，不继承其他变量（避免把宿主机的密钥泄给 agent）；hostPath 恒等。
- `createBwrapSandboxProvider()`（Linux）：`bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp` + 每个 rw 挂载 `--bind`、ro 挂载 `--ro-bind`；network 'none' 时 `--unshare-net`；`--die-with-parent`、`--new-session`；env 同上用 `--clearenv` + `--setenv`。available()：平台是 linux 且 `bwrap --version` 成功。
- `createDockerSandboxProvider({ image })`：create 时 `docker run -d --rm` 一个常驻容器（`sleep infinity`），按 mounts 加 `-v`、按 network 设 `--network none` 或默认、按 limits 设 `--cpus/--memory`；spawn = `docker exec -i [-w] [-e]... <id> cmd args`；dispose = `docker rm -f`。hostPath：按挂载表把容器路径映射回宿主机路径。available()：`docker info` 成功。
- `selectSandboxProvider(config.sandbox, platform)`：按配置选择，不可用时说明原因（不静默降级到 local，除非配置就是 local）。
- 所有提供方的 spawn 都返回真正的 `ChildProcess`，harness 适配器无需区分。

### 2. 代码仓库（packages/sandbox/src/repos.ts，实现 interfaces.ts 的 RepoManager）
- `createRepoManager({ projectDir, taktDir, repos })`：镜像在 `.takt/repos/<id>`（有 url 时 `git clone --mirror` 后 fetch；只有本地 path 时直接用该仓库）；worktree 在 `.takt/worktrees/<runId>/<nodeId 安全化>`，分支 `takt/<runId>/<nodeId>`，基于 base（默认 defaultBranch 的最新提交）；diff 返回统一 diff 与文件列表；removeWorktree 用 `git worktree remove --force` 并 prune。
- 并发安全：同一仓库的 git 操作串行（进程内锁）。

### 3. 技能同步（packages/sandbox/src/skills.ts）
- `syncSkills({ skillsDir, targetRoot, harness })`：把空间 `skills/*` 复制（或软链）到目标目录下 harness 认识的位置：claude-code → `.claude/skills/`，codex / opencode / pi / 其他 → `.agents/skills/`；不覆盖目标里同名的已有技能，返回同步清单。

### 4. harness 接入沙箱与 Linux
- `process.ts`：`req.sandbox` 存在时用 `req.sandbox.spawn` 启动 harness 进程，否则维持原行为；超时、取消、transcript 逻辑不变。
- native 的 bash 工具：macOS 继续 sandbox-exec；Linux 用 bwrap（写权限白名单映射为 `--bind`，其余只读）；两者都不可用时不提供 bash 工具并在 available / 工具描述里说明。
- `dsh.ts`：可执行文件路径解析顺序 `DSH_BIN` → PATH 里的 `dsh` → macOS 默认安装路径；Linux 下不再引用 macOS 路径。
- 全仓库检查：除了明确的 macOS 分支，不能有写死的 macOS 路径（`/Applications`、`/Users`）。

### 5. CI 与容器
- `.github/workflows/ci.yml`：push / PR 触发；矩阵 `ubuntu-latest`、`macos-latest`，Node 22；步骤 `npm ci`、`npm run typecheck`、`npx vitest run`、`npm run demo`、`npm run build -w @taktflow/web`；ubuntu 额外安装 `bubblewrap ripgrep` 并跑沙箱的 bwrap 测试（测试在不可用时 skip，CI 上要求可用）；另一个 job 构建 Docker 镜像（不推送）。
- `Dockerfile`：多阶段；运行镜像基于 `node:22-bookworm-slim`，装 `git ripgrep bubblewrap ca-certificates`，复制构建产物与 web dist，默认命令 `node packages/cli/dist/index.js serve --host 0.0.0.0 --port 4870 --project /space`；`ARG INSTALL_AGENT_CLIS=false` 为 true 时额外 `npm i -g` Claude Code、Codex、OpenCode、Pi 的 CLI（包名写成可覆盖的 ARG）。
- `docker-compose.yml`：一个 server 服务，挂载 `./space:/space`，端口 4870，环境变量从 `.env` 读取（示例 `.env.example` 只列变量名）。

### 测试
- local / bwrap / docker 三个提供方：同一组契约测试（spawn 输出、env 白名单、只读挂载写入失败、rw 挂载可写、network none 时连不上外网（用 `getent hosts` 或连 1.1.1.1:53 超时判断））；不可用的提供方 skip。
- RepoManager：临时 git 仓库上建 worktree、改文件、diff、删除；两个 worktree 并行互不影响。
- syncSkills；process.ts 走沙箱 spawn（用 local 提供方）。

### 完成定义
`npm run typecheck`、`npx vitest run packages/sandbox packages/harness`、`npm run demo` 通过；CI 配置用 `npx --yes @action-validator/cli` 或等价方式做语法校验（不可用时至少 `node -e` 解析 YAML）。

---

## 任务 m2-pi

**负责范围**：`packages/harness/src/adapters/pi.ts`、`pi.test.ts`、`packages/harness/src/index.ts`（只做注册）。

- 适配 Pi coding agent（github.com/earendil-works/pi，`packages/coding-agent`）。无头调用：`pi --mode json [--model <m>] [--provider <p>] "<prompt>"`（以官方文档 `packages/coding-agent/docs/json.md`、`README.md` 为准：先用 `gh api repos/earendil-works/pi/contents/packages/coding-agent/docs/json.md --jq .content | base64 -d` 读文档，核对参数；续会话、模型选择、prompt 走 stdin 还是参数都以文档为准）。
- 输出是严格 JSONL：首条 `{"type":"session",...}`（取 id 作为 sessionId），之后 agent / turn / message / tool 事件；`message_update` 是增量，要按文档重建最终消息；注意文档说明不能用按 Unicode 行分隔符切分的读法，只按 LF 切分。映射到 HarnessEvent：started、message、tool_call、usage、compacted（如果有压缩事件）。
- capabilities 按文档如实声明；available()：`pi --version`。
- 用 `runHarnessConformance` 测试，录制样例按文档里的事件格式构造。

### 完成定义
`npx tsc -p packages/harness/tsconfig.json --noEmit`、`npx vitest run packages/harness/src/adapters` 通过；`npm run takt -- harness ls --project examples/hello-delivery` 能看到 pi。
