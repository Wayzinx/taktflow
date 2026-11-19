import { Github, MessageCircle } from 'lucide-react'

const guides = 'https://github.com/Wayzinx/taktflow/blob/main/examples/team-delivery/'

export function OtherChannels() {
  return <>
    <section className="card feishu-settings">
      <div className="card-head feishu-head"><h2 className="card-title"><Github aria-hidden /> GitHub Issue</h2></div>
      <div className="feishu-body feishu-intro">
        <p>在已绑定仓库的 Issue 评论里 @机器人，可以讨论、发起编排或派活。管理员在 Hub 配置仓库、成员和回调地址。</p>
        <a className="btn btn-sm" href={guides + 'github.md'} target="_blank" rel="noreferrer">查看 GitHub 接入步骤</a>
      </div>
    </section>
    <section className="card feishu-settings">
      <div className="card-head feishu-head"><h2 className="card-title"><MessageCircle aria-hidden /> 个人微信</h2></div>
      <div className="feishu-body feishu-intro">
        <p>在微信扫码授权后，由管理员在 Hub 将该微信账号绑定到一个空间成员。私聊机器人时，消息会进入空间讨论，对其他成员可见。</p>
        <a className="btn btn-sm" href={guides + 'wechat.md'} target="_blank" rel="noreferrer">查看微信接入步骤</a>
      </div>
    </section>
  </>
}
