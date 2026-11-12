import { useEffect, useMemo, useState } from 'react'
import { ListChecks, LoaderCircle } from 'lucide-react'
import type { EvalTarget, EvalVariant, HarnessInfo, HarnessSelector } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { Dialog, EmptyState, SkeletonRows, toast } from '../../components/ui'
import { navigate } from '../../lib/router'
import { CASE_SOURCE, defaultHarness, SAMPLE_KIND, shortId, targetKey } from './labels'

const parse = (s: string): EvalTarget | undefined => {
  const m = /^node:([^/]+)\/(.+)$/.exec(s)
  if (m) return { kind: 'node', workflowId: m[1]!, nodeId: m[2]! }
  const k = /^skill:(.+)$/.exec(s)
  return k ? { kind: 'skill', name: k[1]! } : undefined
}

/** 新建评测：选目标与用例，填一个候选变体（基线由后端自动加"当前配方"）。 */
export function NewRunDialog({ open, initialTarget, onClose }: { open: boolean; initialTarget?: string; onClose: () => void }) {
  const ds = useSource()
  const targets = useAsync(async (d) => {
    const [nodes, skills, all] = await Promise.all([d.scorecards('node'), d.scorecards('skill'), d.evalCases().catch(() => [])])
    const options = [
      ...nodes.map((n) => ({ value: `node:${n.key.workflowId}/${n.key.nodeId}`, label: `节点 · ${n.label}${n.label.includes(n.key.nodeId!) ? '' : `（${n.key.nodeId}）`}`, role: n.role })),
      ...[...new Set(skills.map((s) => s.key.skill!.name))].map((name) => ({ value: `skill:${name}`, label: `技能 · ${name}`, role: undefined as string | undefined })),
    ]
    // 检查点样本的目标是检查点所在节点，可能不在成绩单里：补上
    for (const c of all) {
      const k = targetKey(c.target)
      if (c.sample && c.target.kind === 'node' && !options.some((o) => o.value === k)) options.push({ value: k, label: `节点 · ${c.target.nodeId}`, role: c.node.role })
    }
    // 有在用样本的目标排在前面（默认选中第一个），其余保持成绩单顺序
    const marked = options.map((o) => ({ ...o, cases: all.some((c) => targetKey(c.target) === o.value && c.sample && !c.sample.retiredAt) }))
    return [...marked.filter((o) => o.cases), ...marked.filter((o) => !o.cases)]
  }, [])
  const harnesses = useAsync((d) => d.harnesses(), [])
  const [target, setTarget] = useState(initialTarget ?? '')
  // 打开时：链接给了目标就用它；否则保留上次的选择，没有选择或选择已不在列表里时取列表第一项（不写死某个 workflow）
  useEffect(() => {
    if (!open) return
    if (initialTarget) setTarget(initialTarget)
    else if (targets.data) setTarget((t) => (targets.data!.some((o) => o.value === t) ? t : (targets.data![0]?.value ?? '')))
  }, [open, initialTarget, targets.data])
  const role = targets.data?.find((o) => o.value === target)?.role
  const cases = useAsync((d) => (target ? d.evalCases(target) : Promise.resolve([])), [target])
  const [picked, setPicked] = useState<Set<string> | null>(null)
  useEffect(() => setPicked(null), [target])
  // 本期只回放只读检查点样本：旧整节点用例与已退役样本不能勾选
  const usable = useMemo(() => (cases.data ?? []).filter((c) => c.sample && !c.sample.retiredAt), [cases.data])
  const legacy = (cases.data ?? []).filter((c) => !c.sample)
  const selected = useMemo(() => picked ?? new Set(usable.map((c) => c.id)), [picked, usable])
  const [repeats, setRepeats] = useState(3)
  const repeatsOk = Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 10
  const [v, setV] = useState({ label: '', skillsDir: '', promptFile: '', profileFile: '', harness: '', model: '', judgeHarness: '', judge: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const hasOverride = Boolean(v.skillsDir || v.promptFile || v.profileFile || v.harness || v.model)
  // 只填模型时 harness 按角色默认（被测节点的角色 / 判分的 evaluator）
  const variantHarness = v.harness || (v.model ? defaultHarness(harnesses.data, role) : undefined)
  const judgeHarness = v.judgeHarness || (v.judge ? defaultHarness(harnesses.data, 'evaluator') : undefined)
  const judge: HarnessSelector | undefined = v.judge || v.judgeHarness ? (judgeHarness ? { harness: judgeHarness, model: v.judge || undefined } : undefined) : undefined
  const variantId = v.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  // 变体 id 叫 baseline 时服务端不再自动加基线，也就没有对比结果
  const idTaken = variantId === 'baseline'
  const harnessMissing = (Boolean(v.model) && !variantHarness) || (Boolean(v.judge) && !judgeHarness)
  const ok = Boolean(parse(target)) && selected.size > 0 && repeatsOk && v.label.trim() && hasOverride && !idTaken && !harnessMissing && !busy

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  const submit = async () => {
    const t = parse(target)
    if (!t || !ok) return
    const variant: EvalVariant = {
      id: variantId || `v${Date.now() % 10000}`,
      label: v.label.trim(),
      skillsDir: v.skillsDir || undefined,
      promptFile: v.promptFile || undefined,
      profileFile: v.profileFile || undefined,
      harness: variantHarness ? { harness: variantHarness, model: v.model || undefined } : undefined,
    }
    setBusy(true)
    try {
      const run = await ds.startEvalRun({ target: t, variants: [variant], caseIds: [...selected], judge, repeats })
      invalidate()
      onClose()
      navigate(`/eval?tab=runs&run=${run.id}`)
    } catch (e) {
      toast('没能开始评测', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissible={!v.label && !hasOverride}
      title="新建评测"
      description="在隔离环境里回放只读检查点样本，与当前配方配对比较；每个样本重复多次，按预先规定的发布门槛给结论。"
      footer={
        <>
          <button className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-sm btn-primary" disabled={!ok} aria-busy={busy} onClick={submit}>
            {busy && <LoaderCircle className="spin" aria-hidden />}
            {`开始评测（${selected.size} 个样本 × 2 个版本 × ${repeatsOk ? repeats : '?'} 次）`}
          </button>
        </>
      }
    >
      <div className="ev-form">
        <label className="ev-field">
          <span className="ev-label">被测目标</span>
          <select className="select input" value={target} disabled={!targets.data} onChange={(e) => setTarget(e.target.value)}>
            {!targets.data && <option value={target}>{target || '读取被测目标'}</option>}
            {targets.data?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
                {o.cases ? '' : ' · 无样本'}
              </option>
            ))}
          </select>
        </label>
        <div className="ev-field">
          <span className="ev-label">
            样本
            <span className="faint num"> · 已选 {selected.size} / {usable.length}</span>
          </span>
          <div className="ev-cases">
            {!cases.data ? (
              <SkeletonRows rows={3} gap={10} />
            ) : usable.length === 0 && legacy.length === 0 ? (
              <EmptyState compact icon={ListChecks} title="这个目标还没有样本" body="确认一个本该拦住的漏检后，在缺陷详情里生成必拦样本；评审调用确认没问题时，在检查点里生成无缺陷样本。" />
            ) : (
              <>
                {usable.map((c) => (
                  <label key={c.id} className="ev-case-opt">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className={`er-tag er-tone-${SAMPLE_KIND[c.sample!.kind].tone}`}>{SAMPLE_KIND[c.sample!.kind].label}</span>
                    <span className="truncate">{c.title}</span>
                    <span className="mono faint" title={c.id}>
                      {shortId(c.id)}
                    </span>
                  </label>
                ))}
                {legacy.map((c) => (
                  <label key={c.id} className="ev-case-opt is-off" title="旧整节点用例：本期只回放只读检查点，不能勾选">
                    <input type="checkbox" checked={false} disabled />
                    <span className={`ev-src ev-src-${c.source.kind}`}>{CASE_SOURCE[c.source.kind]}</span>
                    <span className="truncate">{c.title}</span>
                    <span className="mono faint">{c.id}</span>
                  </label>
                ))}
              </>
            )}
          </div>
          {legacy.length > 0 && <span className="faint ev-cases-note">{legacy.length} 条旧整节点用例本期不再回放（写代码 / 整节点重执行后续再做）。</span>}
        </div>
        <label className="ev-field ev-repeats">
          <span className="ev-label">每个样本重复</span>
          <span className="ev-pair">
            <input className="input num" type="number" min={1} max={10} value={Number.isFinite(repeats) ? repeats : ''} onChange={(e) => setRepeats(e.target.valueAsNumber)} aria-describedby="ev-repeats-hint" />
            <span id="ev-repeats-hint" className="faint">次（1–10）。低于空间门槛的最少重复次数时，报告只作探索。</span>
          </span>
        </label>
        <fieldset className="ev-variant">
          <legend className="ev-label">候选变体（在当前配方上覆盖，至少填一项）</legend>
          <label className="ev-field">
            <span className="ev-sub">名称</span>
            <input className="input" value={v.label} onChange={set('label')} placeholder="例如：测分 prompt v9：补并发场景" />
          </label>
          <div className="ev-grid">
            <label className="ev-field">
              <span className="ev-sub">技能目录</span>
              <input className="input mono" value={v.skillsDir} onChange={set('skillsDir')} placeholder="evals/variants/skills-v5" />
            </label>
            <label className="ev-field">
              <span className="ev-sub">Prompt 文件</span>
              <input className="input mono" value={v.promptFile} onChange={set('promptFile')} placeholder="evals/variants/prompt.md" />
            </label>
            <label className="ev-field">
              <span className="ev-sub">角色档案</span>
              <input className="input mono" value={v.profileFile} onChange={set('profileFile')} placeholder={`agents/${role ?? 'test-designer'}.v2.md`} />
            </label>
            <label className="ev-field">
              <span className="ev-sub">Harness / 模型</span>
              <span className="ev-pair">
                <HarnessSelect harnesses={harnesses.data} value={v.harness} onChange={set('harness')} fallback={defaultHarness(harnesses.data, role)} label="候选变体的 harness" />
                <input className="input mono" value={v.model} onChange={set('model')} placeholder="gpt-5-codex" aria-label="候选变体的模型" />
              </span>
            </label>
          </div>
        </fieldset>
        <div className="ev-field">
          <span className="ev-sub">判分 harness / 模型（可选，模型必须不同于被测模型；不填用 evaluator 角色的默认）</span>
          <span className="ev-pair">
            <HarnessSelect harnesses={harnesses.data} value={v.judgeHarness} onChange={set('judgeHarness')} fallback={defaultHarness(harnesses.data, 'evaluator')} label="判分 harness" />
            <input className="input mono" value={v.judge} onChange={set('judge')} placeholder="claude-opus-4.1" aria-label="判分模型" />
          </span>
        </div>
        {idTaken && <p className="sc-bad">名称不能生成 id「baseline」：它留给自动加的当前配方基线，换个名称。</p>}
        {harnessMissing && <p className="sc-bad">空间里没有可用的 harness，先在设置 → 运行环境里配置，或手动选一个。</p>}
        {target && !parse(target) && <p className="sc-bad">目标格式应为 node:&lt;workflow&gt;/&lt;node&gt; 或 skill:&lt;name&gt;</p>}
      </div>
    </Dialog>
  )
}

/** harness 下拉：空值表示"按角色默认"，括号里标出会用哪个。 */
function HarnessSelect({ harnesses, value, onChange, fallback, label }: { harnesses?: HarnessInfo[]; value: string; onChange: (e: { target: { value: string } }) => void; fallback?: string; label: string }) {
  return (
    <select className="select input mono" value={value} onChange={onChange} aria-label={label}>
      <option value="">{fallback ? `默认（${fallback}）` : '默认'}</option>
      {harnesses?.map((h) => (
        <option key={h.id} value={h.id} disabled={!h.available} title={h.available ? h.displayName : h.reason}>
          {h.id}
          {h.available ? '' : '（不可用）'}
        </option>
      ))}
    </select>
  )
}
