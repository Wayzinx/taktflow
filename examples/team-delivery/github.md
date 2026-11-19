# 在 GitHub Issue 里使用空间管家

成员可以在 GitHub 网页或手机 App 打开一个进行中的 Issue，在新评论开头 @ 管家。管家以这个成员的空间权限讨论方案、创建需求或向已连接的开发机派发任务。原评论与管家的回复进入绑定空间的共享会话。

## 连接仓库和空间

1. 给管家准备一个 GitHub 专用用户，为该用户创建限定目标仓库的 fine-grained personal access token，授予 Issues 读写权限。Hub 通过此账号回复原 Issue。[GitHub 令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
2. 在 Taktflow 空间设置确认发言人已经是 owner、maintainer 或 member。用下列只读命令查仓库、管家和发言人的 GitHub 数字 ID。成员改登录名后可继续使用已有映射。

   ```sh
   gh api repos/your-org/shop --jq '.id'
   gh api users/takt-bot --jq '.id'
   gh api users/alice --jq '.id'
   ```

3. 在 Hub 的进程环境中设置下列变量。把示例 ID、名称、空间成员 ID 换成实际值。通过服务的密钥配置注入 token 和 webhook secret。每个仓库可绑定一个空间，数组可以登记多个仓库。启用或修改映射后重启 Hub。

   | 变量 | 内容 |
   | --- | --- |
   | `TAKT_GITHUB_TOKEN` | 专用用户的仓库级令牌 |
   | `TAKT_GITHUB_BOT_ID` | 专用用户的数字 ID，例如 `12345` |
   | `TAKT_GITHUB_BOT_LOGIN` | 专用用户的登录名，例如 `takt-bot` |
   | `TAKT_GITHUB_WEBHOOK_SECRET` | 与仓库 Webhook 共用的随机密钥 |
   | `TAKT_GITHUB_BINDINGS` | 如下所示的 JSON 数组 |

   ```json
   [{"repo":"your-org/shop","repoId":123456,"spaceId":"shop","members":{"45678":"alice"},"privateReplies":false}]
   ```

4. 在仓库 **Settings → Webhooks → Add webhook** 中填写 Hub 的 HTTPS 地址加 `/api/github/events`，选择 `application/json`，填写同一个 secret，选择 **Issue comments**，保留 SSL 验证。反向代理应把此回调原样转给 Hub。GitHub 的 ping 投递收到 HTTP 202 表示连接和签名正常。[GitHub Webhook 配置](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks) · [GitHub 签名验证](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

## 从手机或网页发起任务

在已绑定仓库的开放 Issue 中，以管家登录名开始一条新评论。示例假设空间登记了 `delivery` 流程和在线节点 `mac-dev`。

| 评论 | 空间内的动作 |
| --- | --- |
| `@takt-bot 这个导出功能应该怎么验收？` | 在共享会话讨论 |
| `@takt-bot /workflow delivery 增加订单 CSV 导出` | 创建需求并请求启动指定流程 |
| `@takt-bot /vibe mac-dev 给导出按钮加加载反馈` | 把任务派给指定在线节点 |

查看聊天回复、需求、运行和作业状态可打开 Taktflow 空间。默认情况下，原 Issue 收到处理回执。管理员确认**私有仓库全体读者都可以阅读空间管家的回复**后，可在该仓库绑定中设置 `privateReplies: true`。Hub 回帖前检查仓库可见性，公开或 internal 仓库始终只收回执。已经发布的回复遵循 GitHub 此后对仓库和读者权限的更改。

管家处理新建评论。修改任务时请另发一条新评论。PR 讨论、引用中的 @、机器人的回复和未映射成员的发言会被忽略。Webhooks 页的 **Recent Deliveries** 可查看签名或配置错误。一天内重新投递同一事件会沿用原评论回执。配对测试可使用本地模拟的 GitHub API 运行，不需要仓库凭据。

```sh
npx vitest run packages/server/src/github-channel.test.ts
```
