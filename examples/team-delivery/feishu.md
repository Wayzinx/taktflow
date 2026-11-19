# 在飞书群使用项目空间管家

团队成员可以在手机飞书群里讨论、把讨论转成需求、启动空间已有的工作流，并处理审批。飞书里的对话和 Web 管家里的「空间讨论」写入同一份空间记录。直接选择开发机做 Vibe Coding 的入口在 Web 的「直接开发」中。

## 配置企业自建应用

1. 在飞书开放平台创建企业自建应用，添加「机器人」能力。申请读取群聊中 @机器人的消息（`im:message.group_at_msg:readonly`）和以应用身份发消息（`im:message:send_as_bot`）权限。
2. 在「事件与回调」选择将事件发送到开发者服务器，配置 Encrypt Key 和 Verification Token。订阅消息事件 `im.message.receive_v1` 和卡片回调 `card.action.trigger`。事件和回调的请求地址都填写 `https://<回调域名>/api/feishu/events`。先按下节启动 Hub，再完成飞书的地址校验、发布应用并把机器人加到目标群。
3. 准备本租户的 tenant key、机器人自己的 open_id、绑定群的 chat_id 和成员在**这个应用**下的 open_id。群 ID 以 `oc_` 开头，成员和机器人的 open_id 以 `ou_` 开头。可从该应用收到的测试群 @机器人事件中核对 `header.tenant_key`、`event.message.chat_id`、`event.sender.sender_id.open_id` 与 `event.message.mentions[].id.open_id`。飞书客户端中应选中机器人的真实提及。

## 配置 Hub

一个 Hub 接一个飞书中国版企业应用和租户。将下列变量放入 Hub 服务进程的私密环境，重启 Hub 后生效。

| 环境变量 | 来源 |
| --- | --- |
| `TAKT_FEISHU_APP_ID`、`TAKT_FEISHU_APP_SECRET` | 飞书应用凭证 |
| `TAKT_FEISHU_VERIFICATION_TOKEN`、`TAKT_FEISHU_ENCRYPT_KEY` | 事件与回调的安全配置 |
| `TAKT_FEISHU_TENANT_KEY`、`TAKT_FEISHU_BOT_OPEN_ID` | 企业租户和本应用机器人身份 |
| `TAKT_FEISHU_PUBLIC_URL` | 团队成员手机可访问的 Taktflow Web HTTPS 源地址，如 `https://takt.example.com` |

按现有方式运行 `npm run takt -- serve --spaces ./spaces`。反向代理将公开的 `POST /api/feishu/events` 转发到 Hub，保留原始请求体和 `X-Lark-*` 请求头。Web 深链走团队的身份网关，网关验证登录用户、限制空间访问、覆盖客户端传入的 `X-Takt-User`。原有单向自动化通知仍使用独立的 Webhook 配置。

## 绑定群并开始对话

1. 在「空间设置 → 成员」中添加同事。使用 Owner 身份打开「空间设置 → 飞书」。在本机开发模式，先在「待办」页的「我是」中显式选择 Owner。
2. 输入群 ID，将每位需要发指令的同事的 open_id 对应到空间成员，保存绑定。每个群对应一个空间。绑定后，群里所有人都能看到群消息及卡片，包括 Web 发到共享会话的新内容。选用与项目可见范围一致的群。只有已映射且拥有 Member 或 Owner 权限的成员能发起操作。
3. 试发 `@管家 这个需求现在进展怎样？`。群中回复也保存在空间会话。自然语言讨论使用空间配置的管家模型，模型不可用时返回空间摘要。
4. 发 `@管家 建需求 为导出记录增加日期过滤`，或讨论后发 `@管家 把刚讨论的方案建成需求`。在草稿卡片点选工作流，管家以点击者身份创建需求、启动流程并返回 Web 链接。多人重复确认同一份草稿会复用首次处理结果。
5. 群里会收到这次运行的人工待办和结束状态。可直接在审批卡点「批准」或「拒绝」，开放式问题从卡片打开 Web 作答。`@管家 待办` 可查看当前空间待处理的工作流事项。

Owner 可修改映射或解绑，旧版本的卡片随即失效。系统从当前绑定生效时开始转发新增会话消息。主动通知跟踪绑定期间从共享会话发起的运行。

## 回调与恢复

Hub 验证事件签名、时间、应用、租户和加密正文，并在处理及回发前复核空间绑定。回调持久化后即应答。消息收发可在单 Hub 重启后继续，发送重试复用同一个飞书消息 UUID。连续失败或超过可安全重发的时间窗口时，会记录停止原因。已完成及停止的队列回执保留约七天。

多空间 Hub 的绑定与收发队列保存在空间根目录的 `.takt-feishu/`，单空间模式保存在 `.takt/runs/.feishu-hub/`。项目级卡片和通知进度分别在 `.takt/chat/.feishu-actions/` 和 `.takt/runs/.feishu-sync/`。备份空间时一并保留 Hub 目录。当前使用单进程 Hub。
