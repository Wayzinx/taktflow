# 从个人微信与项目管家对话

用个人微信给已经绑定的机器人发送文字私聊。管家在原微信对话中回复，项目成员可以在网页的「管家 → 空间讨论」看到双方的消息。账号绑定到一个项目空间和一位已有成员。群聊、图片、语音、文件及其他微信用户的消息会被跳过。

## 扫码授权

在运行 Hub 的机器上安装 OpenClaw 和腾讯官方微信插件。已授权的账号可以直接使用它现有的账号文件。首次授权时，在终端运行以下命令，用将要发言的个人微信扫码确认。具体账号文件通常位于 `~/.openclaw/openclaw-weixin/accounts/<账号ID>.json`。自定义 OpenClaw 状态目录时，路径随之改变。[腾讯插件的安装与登录说明](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md)

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin"
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw channels login --channel openclaw-weixin
```

## 让账号在团队空间发言

在「空间设置 → 成员」查看扫码用户对应的成员 ID。成员需要发言权限。由 Hub 管理员核实扫码人和成员后，在 Taktflow 仓库目录执行下例。将 `shop`、`alice`、`YOUR_ACCOUNT_ID` 替换为实际的空间目录、成员 ID 和账号文件名。

```bash
npm run takt -- wechat listen \
  --project ./spaces/shop \
  --by alice \
  --config "$HOME/.openclaw/openclaw-weixin/accounts/YOUR_ACCOUNT_ID.json"
```

同一个微信机器人只运行一个接收进程。若该账号正由 OpenClaw 网关、Persona 或其他 Taktflow 实例接收消息，先停止它对该账号的轮询。新消息由上述命令前台接收，按 Ctrl+C 停止。Hub 主机需要能够访问腾讯 iLink HTTPS 服务。

首次启动会在账号文件旁生成仅当前用户可读取的 `.taktflow.json` 文件，保存空间绑定、接收进度和待回复消息。保留这两个文件在项目目录之外，重启时使用同一条命令即可继续。每次处理消息与发回回复前都会重新检查成员权限。发送失败时原消息保留在空间内，修复登录或网络问题后重启可继续回复。

## 验证

用绑定账号发送「这个空间有多少需求？」。在网页的「空间讨论」核对发言人、原文和回复，再确认微信收到了同一条回复。模型暂不可用时，管家会返回本空间的实际状态。此入口处理文字对话，开发派单可在空间讨论中选择工作流或在线设备。
