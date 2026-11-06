import { useMemo, useState } from 'react'
import { ChevronLeft, CornerDownLeft } from 'lucide-react'
import type { CommandInfo, CommandRunResponse } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { JsonView } from '../../lib/json-view'
import { RiskTag, ReasonField, reasonOk } from '../ui/reason-dialog'
import { toast } from '../ui'
import { CommandField } from './fields'
import type { PaletteData } from './items'
import { fieldsOf, initialValues, toInput, type FieldValue } from './schema'

/**
 * ⌘K 第二步：按命令的 input schema 生成表单。
 * 需求 / 运行 / 节点从当前页面自动带入；write / dangerous 必须写原因；
 * 查询结果留在面板里看，命令执行成功后关闭并通知。业务失败（ok: false）把消息留在表单上。
 */
export function CommandForm({ cmd, given, data, onBack, onDone, backLabel }: { cmd: CommandInfo; given?: Record<string, unknown>; data: PaletteData; onBack: () => void; onDone: () => void; backLabel: string }) {
  const ds = useSource()
  const fields = useMemo(() => fieldsOf(cmd), [cmd])
  const init = useMemo(() => initialValues(fields, data.ctx, given), [fields, data.ctx, given])
  const [values, setValues] = useState<Record<string, FieldValue>>(init.values)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<CommandRunResponse>()

  const needReason = cmd.risk !== 'read'
  const { input, missing, invalid } = toInput(fields, values)
  const ready = !missing.length && !invalid.length && (!needReason || reasonOk(reason)) && !busy
  // 第一个需要手填的字段拿焦点；都已带入时焦点给原因或执行按钮
  const focusKey = fields.find((f) => !init.fromContext.has(f.key) && (f.required || !values[f.key]))?.key

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setRes(undefined)
    try {
      const r = await ds.runCommand(cmd.id, { input, reason: needReason ? reason.trim() : undefined })
      if (r.ok && cmd.kind === 'command') {
        invalidate()
        toast(r.message || `已执行「${cmd.title}」`, { tone: 'success' })
        onDone()
        return
      }
      setRes(r)
      if (r.ok) invalidate()
    } catch (e) {
      setRes({ ok: false, message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const blocker = missing.length ? `还缺：${missing.join('、')}` : invalid.length ? `格式不对：${invalid.join('、')}` : needReason && !reasonOk(reason) ? '写一句原因才能执行' : ''
  const verb = cmd.kind === 'query' ? '查询' : cmd.risk === 'dangerous' ? '确认执行' : '执行'

  return (
    <form
      className="cmdk-step cmdk-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void submit()
        }
      }}
    >
      <div className="cmdk-input-row cmdk-form-head">
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onBack} aria-label={backLabel} title={`${backLabel}（Esc）`}>
          <ChevronLeft />
        </button>
        <span className="cmdk-form-title truncate">{cmd.title}</span>
        <span className="mono cmdk-code">{cmd.id}</span>
        <RiskTag risk={cmd.risk} />
      </div>
      <div className="cmdk-form-body">
        {cmd.risk === 'dangerous' && <p className="cmdk-danger-note">这一步不可撤销，执行前确认参数无误。</p>}
        {fields.map((f) => (
          <CommandField
            key={f.key}
            f={f}
            value={values[f.key] ?? ''}
            onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            fromContext={init.fromContext.has(f.key) && values[f.key] === init.values[f.key]}
            reqs={data.reqs}
            runs={data.runs}
            requirementId={typeof values.requirementId === 'string' ? values.requirementId : undefined}
            autoFocus={f.key === focusKey}
          />
        ))}
        {!fields.length && <p className="cmdk-form-none">这个命令没有参数。</p>}
        {needReason && <ReasonField value={reason} onChange={setReason} risk={cmd.risk} autoFocus={!focusKey} />}
        {res && (
          <div className={`cmdk-result${res.ok ? '' : ' fail'}`} role={res.ok ? 'status' : 'alert'}>
            <div className="cmdk-result-msg">{res.message}</div>
            {res.ok && res.result !== undefined && (
              <div className="cmdk-result-json">
                <JsonView source={JSON.stringify(res.result)} />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="cmdk-foot">
        <span>
          <span className="kbd">⌘</span> <span className="kbd">↵</span> {verb}
        </span>
        <span>
          <span className="kbd">Esc</span> {backLabel}
        </span>
        <span className="cmdk-foot-blocker">{blocker}</span>
        <button type="submit" className={`btn btn-sm ${cmd.risk === 'dangerous' ? 'btn-danger' : 'btn-primary'}`} disabled={!ready}>
          {busy ? '执行中…' : verb}
          {!busy && <CornerDownLeft aria-hidden />}
        </button>
      </div>
    </form>
  )
}
