# 让项目空间的管家调度开发机

成员进入项目空间，打开侧栏的 **团队 Agent**。聊天记录、关联的需求和作业保存在当前空间。Owner 在「空间设置 → 成员」添加同事。Viewer 可以看对话与结果，Member 可以讨论、创建需求和派活。

| 用法 | 操作 | 结果 |
| --- | --- | --- |
| 讨论方案 | 在「聊天」里提问，随后可由其他成员追问 | 管家根据空间内最近的对话、需求、待办和关联的作业回执回答。模型未配置时显示实际状态。 |
| 按流程开发 | 选「编排开发」、流水线，填写目标与验收条件。可勾选附入最近八条消息。 | 管家以发言人的身份创建需求、写入 PRD、请求启动流程。会话提供需求和运行入口，启动失败会单独说明。 |
| 直接开发 | 选「直接开发」、一台在线开发机，描述改动 | Worker 在自己的工作目录运行 Codex，团队在原消息下看到状态和回执。继续派给同一节点即可基于上次的文件改动迭代。 |

## 在 Hub 上准备空间

在本仓库根目录执行。下例在当前目录下创建名为 shop 的新空间，已有空间可直接复用。

```bash
npm ci
npm run build
npm run takt -- init ./spaces/shop --layout space --name '商城研发'
cp examples/team-delivery/team-delivery.workflow.ts ./spaces/shop/workflows/
```

新初始化的空间可直接导入工作流里的 `@taktflow/server`。老空间如果在仓库外，需在其 workflow 目录的 `node_modules/@taktflow/` 里补上指向本构建 `packages/server` 的链接（与已有的 core 链接同级）。旧布局的 workflow 目录一般是 `.takt/workflows`。

「聊天」使用空间配置中 `steward.harness.model` 指定的模型别名，该别名应关联已配置的 `openai-chat` provider。单独使用工作流或 Worker 可以跳过这项设置。

为每个 Worker 生成独立的随机 token，例如用 `openssl rand -hex 32`。将登记表保存在代码库以外、仅运维账号可读的 JSON 文件中。把示例里的占位值换成实际 token。

```json
[
  {"spaceId":"shop","nodeId":"mac-dev","harness":"codex","token":"<mac-dev 独有的随机 token>"},
  {"spaceId":"shop","nodeId":"linux-build","harness":"codex","token":"<linux-build 独有的随机 token>"}
]
```

```bash
TAKT_TEAM_NODES="$(cat /path/to/team-nodes.json)" npm run takt -- serve --spaces ./spaces
```

Hub 默认监听本机 4870。访问 `/s/shop/team` 即可进入会话。登记表在启动时读取，变更凭据后重启 Hub。未登记节点时仍可以使用空间会话和已有工作流。

## 在开发机上运行 Worker

Mac 或 Linux 开发机需要同版本的 Taktflow 构建、已登录的 Codex CLI，以及准备好代码基线的独立工作目录。安装的 Codex 版本需要支持 `exec --ephemeral --ignore-user-config --ignore-rules`。Worker 只需出站连接。把本机的 token 单独存入权限为 0600 的文件。

若从开发机通过 SSH 连接受信任的 Hub，可先建立隧道，再在另一终端运行 Worker。若使用 TLS 反向代理，则把 Worker 地址换成代理的 HTTPS 地址，并只向节点开放 `/api/team-worker/`，由同机代理连接 Hub 的回环地址。

```bash
ssh -N -L 14870:127.0.0.1:4870 operator@hub
```

```bash
node packages/cli/dist/index.js worker \
  --hub http://127.0.0.1:14870 --space shop --node mac-dev \
  --harness codex --project /path/to/dedicated/checkout < /path/to/mac-dev.token
```

每个节点有一个执行槽。使用常规 Codex 登录时，Worker 默认只读取登录凭据。若团队通过私有 provider 使用 Codex，请在节点上设置 `TAKT_WORKER_CODEX_HOME`，指向运维方管理、已配置模型与 provider 的专用 Codex 目录。该选项启用此目录中的 Codex 配置。Worker 在指定代码目录调用 workspace-write 沙箱。Hub 接收文本回执，代码与测试文件保留在执行机，交付时由团队按仓库流程审查 diff 和合并。

## 把远端执行放入工作流

在「编排开发」中选择 **团队 Worker 交付**。示例从需求的 `inputs/prd.md` 读取任务，选取支持 Codex、排队与执行任务总数最少的在线节点，收到成功回执后进入人工复核。管理员也可以在流程里固定 nodeId，或在支持运行参数的入口传 teamNodeId。相同运行、节点和循环轮次复用同一个作业。Worker 失联且租约到期时，Hub 把在途作业标为失败，人工核对机器上的部分改动后可开始新的运行。[工作流源码](team-delivery.workflow.ts)

## 部署与数据边界

Web 端沿用 Taktflow 的成员身份机制。本机「我是」选择器和请求头仅适用于受信环境。多人网络部署需要在入口验证用户身份、覆盖客户端的 `X-Takt-User`、限制成员可访问的空间与旧版 API，并阻止绕过网关直连后台。登录、邀请邮件和 SSO 由部署方接入。SSH 转发整个服务端口的账号也应是受信任的运维人员。

空间共享记录保存在 `.takt/chat/.team-room.json`，Worker 和作业状态保存在 `.takt/runs/.team-hub/state.json`。这两个文件与空间一同备份。首版采用单 Hub 和文件存储，适用于受信任的小团队。

节点主动报告可用能力、按原会话回传结果的设计来自 Collie。将工作计划、机器占用和真实执行状态分开记录的设计参考 Persona。需求、审批和审计继续使用 Taktflow 已有模型。[Collie 节点](https://github.com/lihuanyu0w0/collie/blob/cf5d1287f5358c5631ef5982111b1f06184f6a2f/internal/collie/node.go) · [Persona 调度](https://github.com/nwverse/persona/blob/009f5c061f6dffa1000aefdd87039413089456f2/server/internal/assistant/admission.go)
