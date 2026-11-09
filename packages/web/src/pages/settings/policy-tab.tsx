import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Autonomy, SpaceSettings } from '@taktflow/core'
import { useSource } from '../../api'
import { toast } from '../../components/ui'
import { useDraftForm, useUnsavedWarning } from '../../lib/draft'
import { Field, RevisionsButton, SaveBar, Section, TagInput } from './settings-kit'
import { hasErrors, toForm, toPatch, validateForm } from './policy-form'

const AUTONOMY: Array<{ value: Autonomy; title: string; desc: string }> = [
  { value: 'full', title: '全交给 AI', desc: '文档由 PM / 研发 / 测试 Agent 交叉评审，人工节点由 AI 代答并留痕；只有评审轮次用尽、判决拿不准时才找你。' },
  { value: 'checkpoints', title: '关键节点我来定', desc: '评审签字和最终准出等你确认，其余人工节点 AI 代答。' },
  { value: 'manual', title: '每一步都问我', desc: '流程里的人工节点全部等你回答。' },
]

/** 运行策略：默认流程、自主程度、环境部署、自测、预算。对应 takt.config.json 的这几个字段。 */
export function PolicyTab({ settings, onSaved }: { settings: SpaceSettings; onSaved: (next: SpaceSettings) => void }) {
  const ds = useSource()
  const original = useMemo(() => toForm(settings.config, settings), [settings])
  const { form, setForm, dirty, reset, markSaved } = useDraftForm('policy', original)
  const check = useMemo(() => validateForm(form), [form])
  useUnsavedWarning(dirty)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setEnv = <K extends keyof typeof form.env>(k: K, v: (typeof form.env)[K]) => setForm((f) => ({ ...f, env: { ...f.env, [k]: v } }))
  const currentWorkflow = settings.workflows.find((w) => w.id === form.defaultWorkflow)

  const save = async (reason: string) => {
    const validation = validateForm(form)
    if (hasErrors(validation)) {
      toast('有配置项需要修正', { body: '按字段下方的提示改好后再保存；不会静默丢弃无效值。', tone: 'failed' })
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    const submitted = form
    try {
      const next = await ds.updateConfig(toPatch(form, original, validation.values), reason)
      markSaved(submitted)
      toast('已保存运行策略', { body: '只影响之后启动的运行；正在跑的运行沿用开始时的配置。' })
      onSaved(next)
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    }
  }

  return (
    <div className="card">
      <Section
        title="默认流程"
        hint="让 Lead 开始交付但没说用哪个流程时，用这个。"
        actions={<RevisionsButton kind="config" label="配置的修改记录" onRestored={() => void ds.settings().then(onSaved)} />}
      >
        <Field label="流程" hint={currentWorkflow ? `当前：${currentWorkflow.title}（${currentWorkflow.id}）` : undefined}>
          <select className="select" value={form.defaultWorkflow} onChange={(e) => set('defaultWorkflow', e.target.value)} disabled={settings.workflows.length === 0} title={currentWorkflow ? `${currentWorkflow.title}（${currentWorkflow.id}）` : undefined}>
            {settings.workflows.length === 0 && <option value="">还没有流程，先到 Workflow 页从模板新建</option>}
            {settings.workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.title}（{w.id}）</option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="自主程度" hint="决定流程里的人工节点（审批、澄清、准出）由谁来答。AI 代答会留痕：谁答的、依据是什么，都能在审计里看到。">
        <div className="sk-field wide">
          <div className="sk-choice" role="radiogroup" aria-label="自主程度">
            {AUTONOMY.map((a) => (
              <button key={a.value} type="button" role="radio" aria-checked={form.autonomy === a.value} className={`sk-choice-item${form.autonomy === a.value ? ' on' : ''}`} onClick={() => set('autonomy', a.value)}>
                <span className="sk-choice-title">{a.title}</span>
                <span className="sk-choice-desc">{a.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="环境部署"
        hint="测试前需要把被测服务跑起来时开启：每次运行先准备、部署并探活，结束后回收。命令在空间根目录执行，${VAR} 引用本机环境变量，日志里会脱敏。"
        actions={
          <label className="sk-row">
            <input type="checkbox" checked={form.env.enabled} onChange={(e) => setEnv('enabled', e.target.checked)} />
            <span>需要部署被测环境</span>
          </label>
        }
      >
        {form.env.enabled ? (
          <>
            <Field label="准备（可选）" hint="每次运行执行一次，例如安装依赖。">
              <input className="input mono" value={form.env.setup} onChange={(e) => setEnv('setup', e.target.value)} placeholder="npm ci" />
            </Field>
            <Field label="部署 / 启动（必填）" hint="启动被测服务。" error={check.errors.deploy}>
              <input className="input mono" value={form.env.deploy} onChange={(e) => setEnv('deploy', e.target.value)} placeholder="npm run start" aria-invalid={!!check.errors.deploy} />
            </Field>
            <Field label="探活方式">
              <select className="select" value={form.env.healthKind} onChange={(e) => setEnv('healthKind', e.target.value as (typeof form.env)['healthKind'])}>
                <option value="none">不探活</option>
                <option value="url">访问一个 URL</option>
                <option value="command">执行一条命令</option>
              </select>
            </Field>
            {form.env.healthKind !== 'none' && (
              <Field label={form.env.healthKind === 'url' ? '探活 URL' : '探活命令'} hint="默认最多等 120 秒，每 2 秒探一次。" error={check.errors.health}>
                <input className="input mono" value={form.env.health} onChange={(e) => setEnv('health', e.target.value)} placeholder={form.env.healthKind === 'url' ? 'http://localhost:3000/health' : 'curl -f localhost:3000/health'} aria-invalid={!!check.errors.health} />
              </Field>
            )}
            {form.env.healthKind !== 'none' && (
              <Field label="探活超时（秒）" error={check.errors.healthTimeout}>
                <input className="input num" inputMode="numeric" value={form.env.healthTimeoutSec} onChange={(e) => setEnv('healthTimeoutSec', e.target.value)} placeholder="120" aria-invalid={!!check.errors.healthTimeout} />
              </Field>
            )}
            <Field label="回收（可选）" hint="成功、失败、取消都会执行；失败只记日志。">
              <input className="input mono" value={form.env.teardown} onChange={(e) => setEnv('teardown', e.target.value)} placeholder="npm run stop" />
            </Field>
            <Field label="测试命令（可选）" hint="开发 Agent 自测和交付校验执行的命令；不填时用 package.json 的 test 脚本。">
              <input className="input mono" value={form.env.testCommand} onChange={(e) => setEnv('testCommand', e.target.value)} placeholder="npm test" />
            </Field>
            <div className="sk-field wide">
              <span className="field-label">环境变量</span>
              <div className="sk-kv">
                {form.env.env.map(([k, v], i) => (
                  <Kv key={i} k={k} v={v} invalid={check.invalidEnvRows.has(i)} onChange={(nk, nv) => setEnv('env', form.env.env.map((row, j) => (j === i ? [nk, nv] : row)))} onRemove={() => setEnv('env', form.env.env.filter((_, j) => j !== i))} />
                ))}
              </div>
              {check.errors.env && <p className="sk-field-error" role="alert">{check.errors.env.join('；')}</p>}
              <div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEnv('env', [...form.env.env, ['', '']])}>
                  <Plus />
                  添加变量
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="faint sk-field wide">不部署：测试直接在代码工作区里跑。</p>
        )}
      </Section>

      <Section title="自测" hint="开发、自动化 Agent 改完代码后用受控工具跑测试，结果作为完成证据。只能跑这里允许的命令，Agent 不能自己拼命令。">
        <Field label="超时（分钟）" hint="默认 5 分钟；换算后需在 1 秒到 60 分钟之间。" error={check.errors.selftestTimeout}>
          <input className="input num" inputMode="decimal" value={form.selftestTimeoutMin} onChange={(e) => set('selftestTimeoutMin', e.target.value)} placeholder="5" aria-invalid={!!check.errors.selftestTimeout} />
        </Field>
        <Field label="额外允许的测试命令" hint="除默认测试命令外，启动参数里还允许出现的命令（精确匹配，空格和逗号都保留）。" wide>
          <TagInput value={form.allowedCommands} onChange={(v) => set('allowedCommands', v)} placeholder="例如 npm run test:unit，回车添加" mono ariaLabel="额外允许的测试命令" split="enter" />
        </Field>
      </Section>

      <Section title="预算" hint="单次运行的上限，超过就停下来找你。不填表示不限制；填了就必须是大于 0 的数字。">
        <Field label="Token 上限" error={check.errors.budgetTokens}>
          <input className="input num" inputMode="numeric" value={form.budgetTokens} onChange={(e) => set('budgetTokens', e.target.value)} placeholder="不限" aria-invalid={!!check.errors.budgetTokens} />
        </Field>
        <Field label="时长上限（分钟）" error={check.errors.budgetMinutes}>
          <input className="input num" inputMode="numeric" value={form.budgetMinutes} onChange={(e) => set('budgetMinutes', e.target.value)} placeholder="不限" aria-invalid={!!check.errors.budgetMinutes} />
        </Field>
        <Field label="成本上限（美元）" error={check.errors.budgetCost}>
          <input className="input num" inputMode="decimal" value={form.budgetCost} onChange={(e) => set('budgetCost', e.target.value)} placeholder="不限" aria-invalid={!!check.errors.budgetCost} />
        </Field>
      </Section>

      <SaveBar dirty={dirty} onSave={save} onReset={reset} savedHint="已是最新；改动只影响之后启动的运行" />
    </div>
  )
}

function Kv({ k, v, invalid, onChange, onRemove }: { k: string; v: string; invalid?: boolean; onChange: (k: string, v: string) => void; onRemove: () => void }) {
  return (
    <>
      <input className="input mono" value={k} onChange={(e) => onChange(e.target.value, v)} placeholder="NAME" aria-label="变量名" aria-invalid={invalid || undefined} />
      <input className="input mono" value={v} onChange={(e) => onChange(k, e.target.value)} placeholder="值，或 ${HOST_VAR}" aria-label="变量值" aria-invalid={invalid || undefined} />
      <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onRemove} aria-label="删除变量">
        <Trash2 />
      </button>
    </>
  )
}
