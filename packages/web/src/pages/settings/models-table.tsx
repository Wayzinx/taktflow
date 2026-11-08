import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { KeyRound } from 'lucide-react'
import type { ModelInfo } from '@taktflow/core'
import { protocolColor } from '../../lib/capabilities'

/** 200000 → 200k，128000 → 128k，32768 → 32k，1000000 → 1M。 */
function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  return `${n % 1000 === 0 ? n / 1000 : Math.round(n / 1024)}k`
}

const fmtPrice = (v: number) => `$${v.toFixed(2)}`

/** 上下文窗口用对数刻度：32k 到 1M 跨了 30 倍，线性刻度下小窗口几乎看不见。 */
function contextRatio(n: number): number {
  const lo = Math.log(8_000)
  const hi = Math.log(2_000_000)
  return Math.max(0.06, Math.min(1, (Math.log(n) - lo) / (hi - lo)))
}

/** actions：每行右侧的操作（设置页可编辑时给）；below：行下方的整行内容（测试结果）。 */
export function ModelsTable({ models, actions, below, rowClass }: { models: ModelInfo[]; actions?: (m: ModelInfo) => ReactNode; below?: (m: ModelInfo) => ReactNode; rowClass?: (m: ModelInfo, i: number) => { className?: string; style?: CSSProperties } }) {
  return (
    <div className="models-scroll">
      <table className="table models-table">
        <thead>
          <tr>
            <th style={{ width: '19%' }}>别名</th>
            <th style={{ width: '14%' }}>Provider</th>
            <th style={{ width: '22%' }}>协议</th>
            <th style={{ width: '13%' }}>上下文窗口</th>
            <th className="r" style={{ width: '18%' }}>
              价格 <span className="th-unit">输入 / 输出 · $/1M</span>
            </th>
            <th style={{ width: '14%' }}>密钥</th>
            {actions && <th className="r" style={{ width: 132 }}><span className="sr-only">操作</span></th>}
          </tr>
        </thead>
        <tbody>
          {models.map((m, i) => {
            const rc = rowClass?.(m, i)
            const extra = below?.(m)
            return (
            <Fragment key={m.alias}>
            <tr className={rc?.className} style={rc?.style}>
              <td>
                <div className="model-alias mono truncate">
                  {m.alias}
                  {m.kind === 'embedding' && <span className="model-kind" title="向量模型：知识库向量化用">向量</span>}
                </div>
                <div className="model-id mono truncate" title="厂商侧的模型 ID">
                  {m.id}
                </div>
              </td>
              <td>
                <span className="mono model-provider" title={m.provider}>{m.provider}</span>
              </td>
              <td>
                <span className="proto-pill mono" style={{ '--proto': protocolColor(m.protocol) } as CSSProperties}>
                  {m.protocol}
                </span>
              </td>
              <td>
                {m.contextWindow ? (
                  <span className="mctx-cell">
                    <span className="mono num mctx-num">{fmtContext(m.contextWindow)}</span>
                    <span className="mctx-bar" aria-hidden>
                      <span style={{ width: `${contextRatio(m.contextWindow) * 100}%` }} />
                    </span>
                  </span>
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td className="r">
                {!m.price ? (
                  <span className="faint" title="models 里没有写 price：该模型的成本无法换算">
                    未定价
                  </span>
                ) : m.price.input === 0 && m.price.output === 0 ? (
                  <span className="price-free">免费</span>
                ) : (
                  <span className="mono num price">
                    {fmtPrice(m.price.input)}
                    <span className="price-sep">/</span>
                    {fmtPrice(m.price.output)}
                  </span>
                )}
              </td>
              <td>
                <span className={`key-state${m.keyPresent ? ' ok' : ''}`} title={m.keyPresent ? 'provider 的密钥在环境变量或本机密钥库里（不读取值）' : 'provider 的密钥在环境变量和本机密钥库里都没有：调用会失败'}>
                  <KeyRound />
                  {m.keyPresent ? '已配置' : '未配置'}
                </span>
              </td>
              {actions && <td className="r model-acts">{actions(m)}</td>}
            </tr>
            {extra && (
              <tr className="model-below">
                <td colSpan={actions ? 7 : 6}>{extra}</td>
              </tr>
            )}
            </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
