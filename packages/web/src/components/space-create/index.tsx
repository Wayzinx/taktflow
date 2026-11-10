import { useEffect, useState } from 'react'
import { Check, Copy, Server } from 'lucide-react'
import { invalidate, useAsync, useSource } from '../../api'
import { navigate } from '../../lib/router'
import { spacePath } from '../../lib/space'
import { askSteward, closeCreateSpace, useCreateSpace } from '../../lib/ui-store'
import { Dialog, Kbd, SkeletonText, toast } from '../ui'
import { StepBasics } from './basics'
import { SPACE_COLORS, checkId, checkName, initialForm, toRequest, type SpaceForm } from './model'
import { StepTeam } from './team'
import { StepTemplate } from './template'
import './space-create.css'

const STEPS = ['名称与颜色', '起点', '仓库与成员'] as const

/**
 * 新建空间对话框（docs/design/22 §2.2）：①名称 / id / 描述 / 颜色 ②起点 ③仓库与成员（可跳过）。
 * 全局一份，挂在 app.tsx；开关：openCreateSpace({ copyFrom? }) / closeCreateSpace()。
 * 单空间模式（ServerInfo.multiSpace 为 false）时说明原因并给出 multiSpaceHint。
 */
export function SpaceCreateDialog() {
  const st = useCreateSpace()
  const ds = useSource()
  const q = useAsync((s) => (st.open ? Promise.all([s.serverInfo(), s.spaces(), s.spaces({ archived: true }), s.me().catch(() => undefined)]) : Promise.resolve(undefined)), [st.open, st.nonce])
  const [info, live = [], archived = [], me] = q.data ?? []
  const [step, setStep] = useState(0)
  const [f, setF] = useState<SpaceForm>(() => initialForm())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!st.open) return
    setStep(0)
    setF(initialForm(st.copyFrom))
    setError(undefined)
    setBusy(false)
  }, [st.open, st.nonce, st.copyFrom])
  // 颜色默认取第一个没人用的
  useEffect(() => {
    if (!st.open || !q.data) return
    const used = new Set(live.map((s) => s.color))
    const free = SPACE_COLORS.find((c) => !used.has(c.value)) ?? SPACE_COLORS[live.length % SPACE_COLORS.length]!
    setF((x) => (x.name ? x : { ...x, color: free.value }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data])

  const set = (p: Partial<SpaceForm>) => setF((x) => ({ ...x, ...p }))
  const all = [...live, ...archived]
  const step1ok = checkId(f.id, all).ok && checkName(f.name, live).ok
  const step2ok = f.start !== 'copy' || (!!f.copyFrom && f.parts.length > 0)
  const canNext = step === 0 ? step1ok : step === 1 ? step2ok : true

  const submit = async (skipTeam: boolean) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const body = toRequest(skipTeam ? { ...f, repos: [], members: [] } : f, me ? { id: me.id, name: me.name } : undefined)
      const sp = await ds.createSpace(body)
      closeCreateSpace()
      invalidate()
      toast(`已创建空间「${sp.name}」`, {
        body: <span className="mono">/s/{sp.id}</span>,
        // 设计 22 §1.5 / §2.1：新建空间的撤销是"改为归档"，不彻底删除（归档后可在 /spaces 恢复或删除）
        undoLabel: '撤销（归档）',
        undo: async () => {
          await ds.archiveSpace(sp.id, '撤销新建空间')
          invalidate()
          navigate('/spaces')
          toast(`已归档「${sp.name}」`, { body: '可以在"全部空间"的已归档区恢复或彻底删除' })
        },
      })
      navigate(spacePath(sp.id))
    } catch (e) {
      setError((e as Error).message)
      // id / 名称冲突回到第一步
      if (/id|同名/.test((e as Error).message)) setStep(0)
    } finally {
      setBusy(false)
    }
  }
  const next = () => {
    if (!canNext) return
    if (step < 2) setStep(step + 1)
    else void submit(false)
  }

  const single = info && !info.multiSpace
  return (
    <Dialog
      open={st.open}
      onClose={closeCreateSpace}
      title="新建空间"
      description={single ? undefined : '每个空间是一条独立的交付线：自己的需求、流水线、成员和知识库'}
      size="lg"
      dismissible={!f.name}
      className="sc-dialog"
      footer={
        single ? (
          <button type="button" className="btn" onClick={closeCreateSpace}>
            知道了
          </button>
        ) : (
          <>
            <span className="sc-foot-left">{error ? <span className="ov-error">{error}</span> : <span className="faint">第 {step + 1} / 3 步</span>}</span>
            {step > 0 ? (
              <button type="button" className="btn" onClick={() => setStep(step - 1)}>
                上一步
              </button>
            ) : (
              <button type="button" className="btn" onClick={closeCreateSpace}>
                取消
              </button>
            )}
            {step === 2 && (
              <button type="button" className="btn btn-ghost" onClick={() => void submit(true)} disabled={busy}>
                跳过，直接创建
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={next} disabled={!canNext || busy || !q.data}>
              {busy ? <span className="shimmer-text">正在创建</span> : step < 2 ? '下一步' : '创建空间'}
              <Kbd combo="mod+enter" />
            </button>
          </>
        )
      }
    >
      {!q.data ? (
        <SkeletonText lines={6} />
      ) : single ? (
        <SingleSpaceNote hint={info.multiSpaceHint} />
      ) : (
        <div
          className="sc-body"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (step === 0 && (e.target as HTMLElement).tagName === 'INPUT'))) {
              e.preventDefault()
              next()
            }
          }}
        >
          <ol className="sc-steps" aria-label="步骤">
            {STEPS.map((s, i) => (
              <li key={s} className={`sc-step-dot${i === step ? ' on' : ''}${i < step ? ' done' : ''}`} aria-current={i === step ? 'step' : undefined}>
                <button type="button" onClick={() => i < step && setStep(i)} disabled={i >= step} tabIndex={i < step ? 0 : -1}>
                  <span className="sc-step-num">{i < step ? <Check aria-hidden /> : i + 1}</span>
                  {s}
                </button>
              </li>
            ))}
          </ol>
          <div key={step} className="tab-panel">
            {step === 0 && <StepBasics f={f} set={set} all={all} live={live} />}
            {step === 1 && <StepTemplate f={f} set={set} templates={info?.spaceTemplates} live={live} />}
            {step === 2 && <StepTeam f={f} set={set} me={me} />}
          </div>
        </div>
      )}
    </Dialog>
  )
}

function SingleSpaceNote({ hint }: { hint?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="sc-single">
      <span className="sc-single-icon">
        <Server aria-hidden />
      </span>
      <div className="sc-single-text">
        <strong>现在只能管理这一个空间</strong>
        <p>服务是以单空间模式启动的：它直接指向一个空间目录，没有存放多个空间的上级目录，所以新建不了。换成多空间模式启动后，这里就能新建、切换和归档空间。</p>
        {hint && (
          <div className="sc-hint">
            <code className="mono">{hint}</code>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void navigator.clipboard?.writeText(hint).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1600)))}
              title="复制启动命令"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        )}
        <button type="button" className="btn btn-sm sc-single-ask" onClick={() => (closeCreateSpace(), askSteward('帮我把服务切换到多空间模式，并保留现在这个空间'))}>
          让管家帮我切换
        </button>
      </div>
    </div>
  )
}
