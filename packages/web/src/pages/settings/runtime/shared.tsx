import { useEffect, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Coins, KeyRound, LoaderCircle, PlugZap, RotateCw } from 'lucide-react'
import type { HarnessSelector, Pairing, ProviderProtocol, RuntimeConfig, RuntimeConfigPatch, RuntimeTestRequest, RuntimeTestResult, SecretSource, Usage } from '@taktflow/core'
import { RuntimeConflictError, invalidate, useAsync, useSource } from '../../../api'
import { Dialog, Drawer, ReasonField, reasonOk, toast } from '../../../components/ui'
import { fmtTokens } from '../../../lib/format'

/** 运行配置 + 带 baseRevision 的补丁：保存成功后让卡片、模型表一起刷新。 */
export function useRuntime() {
  const ds = useSource()
  const q = useAsync((d) => d.runtimeConfig(), [])
  const patch = async (p: Omit<RuntimeConfigPatch, 'baseRevision' | 'reason'>, reason: string) => {
    const cfg = q.data
    if (!cfg) throw new Error('运行配置还没载入')
    const next = await ds.patchRuntime({ ...p, baseRevision: cfg.revision, reason })
    invalidate()
    return next
  }
  return { cfg: q.data, error: q.error, reload: q.reload, patch }
}
export type RuntimeApi = ReturnType<typeof useRuntime>

/**
 * 编辑抽屉：表单 + 必填原因 + 保存。保存失败时把消息留在抽屉里；
 * 409（别人刚改过）给"重新载入"，载入后表单按新值重开。
 */
export function EditorDrawer({
  open,
  onClose,
  title,
  description,
  saveLabel = '保存',
  canSave = true,
  onSave,
  onReload,
  children,
  width = 480,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  saveLabel?: string
  canSave?: boolean
  onSave: (reason: string) => Promise<void>
  onReload?: () => void
  children: ReactNode
  width?: number
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; conflict: boolean }>()
  useEffect(() => {
    if (!open) return
    setReason('')
    setBusy(false)
    setError(undefined)
  }, [open])
  const submit = async () => {
    if (!canSave || !reasonOk(reason) || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onSave(reason.trim())
      onClose()
    } catch (e) {
      setError({ message: (e as Error).message, conflict: e instanceof RuntimeConflictError })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width={width}
      className="rt-drawer"
      footer={
        <>
          {error && (
            <span className="ov-error rt-error" role="alert">
              {error.message}
              {error.conflict && onReload && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onReload(); setError(undefined) }}>
                  <RotateCw /> 重新载入
                </button>
              )}
            </span>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!canSave || !reasonOk(reason) || busy} onClick={submit}>
            {busy ? '保存中…' : saveLabel}
          </button>
        </>
      }
    >
      <form
        className="ov-form rt-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
        }}
      >
        {children}
        <ReasonField value={reason} onChange={setReason} placeholder="写给审计和队友看：为什么改这项（改完不用重启 serve，新开的节点生效）" />
      </form>
    </Drawer>
  )
}

export function Field({ label, hint, children, req }: { label: ReactNode; hint?: ReactNode; children: ReactNode; req?: boolean }) {
  return (
    <label className="ov-field">
      <span className="ov-field-label">
        {label}
        {req && <span className="ov-req">必填</span>}
        {hint && <span className="ov-field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export const SECRET: Record<SecretSource, { label: string; hint: string }> = {
  env: { label: '环境变量', hint: '启动 serve 的进程里有这个环境变量（优先使用，不读取值）' },
  local: { label: '本机密钥库', hint: '存在这台机器的本机密钥库里（不进空间目录与 git，任何接口都不回传值）' },
  missing: { label: '缺失', hint: '环境变量和本机密钥库里都没有：调用会失败' },
}

export function KeySource({ name, source }: { name?: string; source?: SecretSource }) {
  if (!name) return <span className="faint">不需要密钥</span>
  const s = source ?? 'missing'
  return (
    <span className={`rt-key is-${s}`} title={SECRET[s].hint}>
      <KeyRound aria-hidden />
      <span className="mono truncate">{name}</span>
      <span className="rt-key-src">{SECRET[s].label}</span>
    </span>
  )
}

/** 测试结果一行：成功绿、失败红，计费的标出来。 */
export function TestOutcome({ r }: { r: RuntimeTestResult }) {
  const detail = prettyDetail(r.detail)
  return (
    <div className={`rt-outcome${r.ok ? ' ok' : ' bad'}`} role="status">
      {r.ok ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
      <span className="rt-outcome-msg">{r.message}</span>
      {r.latencyMs !== undefined && <span className="mono num faint">{r.latencyMs}ms</span>}
      {r.billed && (
        <span className="rt-billed" title="这次测试发出了一次计费请求">
          <Coins aria-hidden />
          已计费
        </span>
      )}
      {detail && <span className="rt-outcome-detail">{detail}</span>}
    </div>
  )
}

/** ACP 握手的 detail 是 JSON：挑出 agent 名称、版本、协议版本给人看。 */
function prettyDetail(detail?: string): string | undefined {
  if (!detail) return
  try {
    const d = JSON.parse(detail) as { name?: string; version?: string; protocolVersion?: number; agentCapabilities?: Record<string, unknown>; pairing?: Pairing; usage?: Usage | null }
    if (typeof d !== 'object' || !d) return detail
    if (d.pairing) return [pairingText(d.pairing), d.usage && `输入 ${fmtTokens(d.usage.inputTokens)} · 输出 ${fmtTokens(d.usage.outputTokens)} token`].filter(Boolean).join(' · ')
    const caps = Object.entries(d.agentCapabilities ?? {}).filter(([, v]) => v === true).map(([k]) => k)
    return [d.name && `${d.name}${d.version ? ` ${d.version}` : ''}`, d.protocolVersion !== undefined && `ACP v${d.protocolVersion}`, caps.length && caps.join(' · ')].filter(Boolean).join(' · ')
  } catch {
    return detail
  }
}

/**
 * 测试按钮：provider 列模型 / harness 探测直接跑；model 会计费，先弹框要用户勾"允许一次最小计费请求"。
 * 结果交给 onResult（卡片 / 行内展示）。
 */
export function TestButton({ target, onResult, label = '测试', ghost }: { target: RuntimeTestRequest['target']; onResult: (r: RuntimeTestResult | undefined) => void; label?: string; ghost?: boolean }) {
  const ds = useSource()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [allow, setAllow] = useState(false)
  const billed = target.kind === 'model' || target.kind === 'pairing'
  const run = async (allowBilled?: boolean) => {
    setBusy(true)
    onResult(undefined)
    try {
      onResult(await ds.testRuntime({ target, allowBilled }))
    } catch (e) {
      onResult({ ok: false, message: (e as Error).message, billed: false })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm${ghost ? ' btn-ghost' : ''} rt-test`}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => (billed ? (setAllow(false), setConfirm(true)) : void run())}
        title={target.kind === 'pairing' ? '真跑一次最小任务（会计费），先确认' : billed ? '发一次 1 token 的请求（会计费），先确认' : target.kind === 'provider' ? '只列模型，不计费' : '跑一次可用性探测（ACP 做一次握手），不发 prompt'}
      >
        {busy ? <LoaderCircle className="spin" aria-hidden /> : <PlugZap aria-hidden />}
        {busy ? '测试中…' : label}
      </button>
      {billed && (
        <Dialog
          open={confirm}
          onClose={() => setConfirm(false)}
          title={target.kind === 'pairing' ? `测试搭配 ${target.harness} × ${target.provider ?? '自带'}` : `测试模型 ${target.kind === 'model' ? target.alias : ''}`}
          description={
            target.kind === 'pairing'
              ? `会真的让 ${target.harness} 跑一次最小任务（只读、回复 OK），${target.model ? `用模型 ${target.model}，` : ''}按实际用量计费；走协议桥的组合会顺带验证转换。`
              : '会真的发一次最小请求（输入几 token、输出 1 token），按这个模型的价格计费。'
          }
          size="sm"
          footer={
            <>
              <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!allow}
                onClick={() => {
                  setConfirm(false)
                  void run(true)
                }}
              >
                发送测试请求
              </button>
            </>
          }
        >
          <label className="rt-check">
            <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} data-autofocus />
            允许一次最小计费请求
          </label>
          <p className="faint rt-check-note">只想确认地址和密钥对不对：用 provider 的「测试」，它只列模型，不计费。</p>
        </Dialog>
      )}
    </>
  )
}

export const EFFORTS: NonNullable<HarnessSelector['effort']>[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** "codex · gpt-5-codex · high" */
export function selectorText(s: HarnessSelector): string {
  return [s.harness, s.model, s.effort].filter(Boolean).join(' · ')
}

export function toast409(e: unknown) {
  if (e instanceof RuntimeConflictError) toast('运行配置刚被别人改过', { body: '已重新载入，再改一次即可。' })
}

export type Cfg = RuntimeConfig

/** 协议的短名：在搭配说明里用（「DeepSeek（Chat）」）。 */
export const PROTOCOL_SHORT: Record<ProviderProtocol, string> = {
  'openai-chat': 'Chat',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Anthropic',
  gemini: 'Gemini',
}

/** "直连 · Anthropic" / "桥接 · Responses ← Chat" / "自带" */
export function pairingText(p: Pairing): string {
  if (p.mode === 'builtin') return '自带'
  if (p.mode === 'direct') return `直连 · ${p.protocol ? PROTOCOL_SHORT[p.protocol] : ''}`
  if (p.mode === 'bridge') return `桥接 · ${p.protocol ? PROTOCOL_SHORT[p.protocol] : '?'} ← ${p.upstream ? PROTOCOL_SHORT[p.upstream] : '?'}`
  return '不可用'
}
