# 沙箱、仓库与技能

从 `@taktflow/sandbox` 导入三个 provider 工厂、`selectSandboxProvider`、`createRepoManager`、`syncSkills`。

- `selectSandboxProvider(config.sandbox, platform)` 返回 Promise；缺省选择 local，显式选择的提供方不可用时抛错，docker 必须配置 image。network/image 配置作为 create 的默认值。
- local 不隔离文件和网络；只过滤继承环境。bwrap 使用只读宿主根、指定挂载及可选断网；宿主文件仍可读，这不是密钥文件读取隔离。docker 为每个任务建容器，exec 前清除镜像 ENV，按白名单和显式配置注入环境。
- `spawn` 返回 ChildProcess。local/bwrap 的 kill 清理进程组；docker kill 会回收任务容器，因此取消一次 exec 后应 dispose 并重建 sandbox，不能继续复用该容器。`exec` 支持 input 和 timeoutMs，后者默认取 spec.limits.timeoutMs。dispose 幂等。
- CPU、内存限制仅 docker 实施。bwrap available 检测 Linux 和版本；真实命名空间权限由契约测试验证，CI 设置 `TAKT_REQUIRE_BWRAP=1`，无法启动时测试失败。
- RepoManager 使用 core.withLock，以仓库公共 git 目录为锁键；远程镜像按默认分支 fetch，本地 path 直接使用已有仓库。diff 包含提交后、暂存、未暂存及未跟踪文件。删除 worktree 保留任务分支，供后续集成或人工处理。
- worktree 目录名保留简单 nodeId，复杂 nodeId 安全化并附哈希避免碰撞；分支保留 `takt/<runId>/<nodeId>`，不合法的 Git 分支名拒绝创建。
- 技能按目录复制，同名目标（含符号链接）不覆盖，返回此次复制的 `{ name, source, target }[]`。claude-code 使用 `.claude/skills`，其他使用 `.agents/skills`。

本机可执行 `npx vitest run packages/sandbox packages/harness`。不可用的 bwrap/docker 集成测试跳过，命令参数测试不代表真实容器验收。Docker 契约测试默认使用 `node:22-bookworm-slim`，可用 `TAKT_TEST_DOCKER_IMAGE` 覆盖。

容器启动前先准备已初始化的 `./space`，将本目录 `.env.example` 复制到仓库根目录 `.env`，按需从运行环境传递变量或填写本地值（不要提交）。运行 `docker compose up --build`。运行镜像保留锁定依赖中的 tsx，以便加载空间的 TypeScript workflow；默认不预装 agent CLI。容器内 bwrap 仍取决于部署环境的 user namespace 权限，未默认授予特权。
