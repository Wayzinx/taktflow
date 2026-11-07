import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Autonomy, SpaceConfigPatch, SpaceConfigSettings, SpaceSettings } from '@taktflow/core'
import { useSource } from '../../api'
import { toast } from '../../components/ui'
import { Field, RevisionsButton, SaveBar, Section, TagInput } from './settings-kit'

const AUTONOMY: Array<{ value: Autonomy; title: string; desc: string }> = [
  { value: 'full', title: '全交给 AI', desc: '文档由 PM / 研发 / 测试 Agent 交叉评审，人工节点由 AI 代答并留痕；只有评审轮次用尽、判决拿不准时才找你。' },
  { value: 'checkpoints', title: '关键节点我来定', desc: '评审签字和最终准出等你确认，其余人工节点 AI 代答。' },
  { value: 'manual', title: '每一步都问我', desc: '流程里的人工节点全部等你回答。' },
]

interface EnvForm {
  enabled: boolean
  setup: string
  deploy: string
  healthKind: 'none' | 'url' | 'command'
  health: string
  healthTimeoutSec: string
  teardown: string
  env: Array<[string, string]>
  testCommand: string
}

interface Form {
  defaultWorkflow: string
  autonomy: Autonomy
  env: EnvForm
  selftestTimeoutMin: string
  allowedCommands: string[]
  budgetTokens: string
  budgetMinutes: string
  budgetCost: string
}

function toForm(c: SpaceConfigSettings, settings: SpaceSettings): Form {
  const e = c.environment
  const health = e?.healthcheck
  return {
    defaultWorkflow: c.defaultWorkflow ?? settings.workflows.find((w) => w.default)?.id ?? '',
    autonomy: c.autonomy ?? 'full',
    env: {
      enabled: !!e,
      setup: e?.setup ?? '',
      deploy: e?.deploy ?? '',
      healthKind: health?.url ? 'url' : health?.command ? 'command' : 'none',
      health: health?.url ?? health?.command ?? '',
      healthTimeoutSec: health?.timeoutMs ? String(Math.round(health.timeoutMs / 1000)) : '',
      teardown: e?.teardown ?? '',
      env: Object.entries(e?.env ?? {}),
      testCommand: e?.testCommand ?? '',
    },
    selftestTimeoutMin: c.selftest?.timeoutMs ? String(c.selftest.timeoutMs / 60000) : '',
    allowedCommands: c.selftest?.allowedCommands ?? [],
    budgetTokens: c.budget?.tokens ? String(c.budget.tokens) : '',
    budgetMinutes: c.budget?.minutes ? String(c.budget.minutes) : '',
    budgetCost: c.budget?.costUsd ? String(c.budget.costUsd) : '',
  }
}

const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

function toPatch(f: Form, original: Form): SpaceConfigPatch {
  const patch: SpaceConfigPatch = {}
  const changed = <K extends keyof Form>(k: K) => JSON.stringify(f[k]) !== JSON.stringify(original[k])
  if (changed('defaultWorkflow') && f.defaultWorkflow) patch.defaultWorkflow = f.defaultWorkflow
  if (changed('autonomy')) patch.autonomy = f.autonomy
  if (changed('env')) {
    const e = f.env
    if (!e.enabled) patch.environment = null
    else {
      const timeout = num(e.healthTimeoutSec)
      patch.environment = {
        deploy: e.deploy.trim(),
        ...(e.setup.trim() ? { setup: e.setup.trim() } : {}),
        ...(e.teardown.trim() ? { teardown: e.teardown.trim() } : {}),
        ...(e.healthKind === 'none' || !e.health.trim() ? {} : { healthcheck: { [e.healthKind]: e.health.trim(), ...(timeout ? { timeoutMs: timeout * 1000 } : {}) } }),
        ...(e.env.some(([k]) => k.trim()) ? { env: Object.fromEntries(e.env.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])) } : {}),
        ...(e.testCommand.trim() ? { testCommand: e.testCommand.trim() } : {}),
      }
    }
  }
  if (changed('selftestTimeoutMin') || changed('allowedCommands')) {
    const minutes = num(f.selftestTimeoutMin)
    const selftest = { ...(minutes ? { timeoutMs: Math.round(minutes * 60000) } : {}), ...(f.allowedCommands.length ? { allowedCommands: f.allowedCommands } : {}) }
    patch.selftest = Object.keys(selftest).length ? selftest : null
  }
  if (changed('budgetTokens') || changed('budgetMinutes') || changed('budgetCost')) {
    const budget = { ...(num(f.budgetTokens) ? { tokens: num(f.budgetTokens) } : {}), ...(num(f.budgetMinutes) ? { minutes: num(f.budgetMinutes) } : {}), ...(num(f.budgetCost) ? { costUsd: num(f.budgetCost) } : {}) }
    patch.budget = Object.keys(budget).length ? budget : null
  }
  return patch
}

/** 运行策略：默认流程、自主程度、环境部署、自测、预算。对应 takt.config.json 的这几个字段。 */
export function PolicyTab({ settings, onSaved }: { settings: SpaceSettings; onSaved: (next: SpaceSettings) => void }) {
  const ds = useSource()
  const original = useMemo(() => toForm(settings.config, settings), [settings])
  const [form, setForm] = useState(original)
  useEffect(() => setForm(original), [original])
  const dirty = JSON.stringify(form) !== JSON.stringify(original)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setEnv = <K extends keyof EnvForm>(k: K, v: EnvForm[K]) => setForm((f) => ({ ...f, env: { ...f.env, [k]: v } }))
  const envInvalid = form.env.enabled && !form.env.deploy.trim()

  const save = async (reason: string) => {
    if (envInvalid) { toast('部署命令必填', { body: '开启环境部署时要填部署 / 启动命令；不需要部署就关掉开关。', tone: 'failed' }); return }
    try {
      const next = await ds.updateConfig(toPatch(form, original), reason)
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
        <Field label="流程">
          <select className="select" value={form.defaultWorkflow} onChange={(e) => set('defaultWorkflow', e.target.value)} disabled={settings.workflows.length === 0}>
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
            <Field label="部署 / 启动（必填）" hint="启动被测服务。">
              <input className="input mono" value={form.env.deploy} onChange={(e) => setEnv('deploy', e.target.value)} placeholder="npm run start" aria-invalid={envInvalid} />
            </Field>
            <Field label="探活方式">
              <select className="select" value={form.env.healthKind} onChange={(e) => setEnv('healthKind', e.target.value as EnvForm['healthKind'])}>
                <option value="none">不探活</option>
                <option value="url">访问一个 URL</option>
                <option value="command">执行一条命令</option>
              </select>
            </Field>
            {form.env.healthKind !== 'none' && (
              <Field label={form.env.healthKind === 'url' ? '探活 URL' : '探活命令'} hint="默认最多等 120 秒，每 2 秒探一次。">
                <input className="input mono" value={form.env.health} onChange={(e) => setEnv('health', e.target.value)} placeholder={form.env.healthKind === 'url' ? 'http://localhost:3000/health' : 'curl -f localhost:3000/health'} />
              </Field>
            )}
            {form.env.healthKind !== 'none' && (
              <Field label="探活超时（秒）">
                <input className="input num" inputMode="numeric" value={form.env.healthTimeoutSec} onChange={(e) => setEnv('healthTimeoutSec', e.target.value.replace(/\D/g, ''))} placeholder="120" />
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
                  <Kv key={i} k={k} v={v} onChange={(nk, nv) => setEnv('env', form.env.env.map((row, j) => (j === i ? [nk, nv] : row)))} onRemove={() => setEnv('env', form.env.env.filter((_, j) => j !== i))} />
                ))}
              </div>
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
        <Field label="超时（分钟）" hint="默认 5 分钟。">
          <input className="input num" inputMode="decimal" value={form.selftestTimeoutMin} onChange={(e) => set('selftestTimeoutMin', e.target.value.replace(/[^\d.]/g, ''))} placeholder="5" />
        </Field>
        <Field label="额外允许的测试命令" hint="除默认测试命令外，启动参数里还允许出现的命令（精确匹配）。" wide>
          <TagInput value={form.allowedCommands} onChange={(v) => set('allowedCommands', v)} placeholder="例如 npm run test:unit，回车添加" mono ariaLabel="额外允许的测试命令" />
        </Field>
      </Section>

      <Section title="预算" hint="单次运行的上限，超过就停下来找你。不填表示不限制。">
        <Field label="Token 上限">
          <input className="input num" inputMode="numeric" value={form.budgetTokens} onChange={(e) => set('budgetTokens', e.target.value.replace(/\D/g, ''))} placeholder="不限" />
        </Field>
        <Field label="时长上限（分钟）">
          <input className="input num" inputMode="numeric" value={form.budgetMinutes} onChange={(e) => set('budgetMinutes', e.target.value.replace(/\D/g, ''))} placeholder="不限" />
        </Field>
        <Field label="成本上限（美元）">
          <input className="input num" inputMode="decimal" value={form.budgetCost} onChange={(e) => set('budgetCost', e.target.value.replace(/[^\d.]/g, ''))} placeholder="不限" />
        </Field>
      </Section>

      <SaveBar dirty={dirty} onSave={save} onReset={() => setForm(original)} savedHint="已是最新；改动只影响之后启动的运行" />
    </div>
  )
}

function Kv({ k, v, onChange, onRemove }: { k: string; v: string; onChange: (k: string, v: string) => void; onRemove: () => void }) {
  return (
    <>
      <input className="input mono" value={k} onChange={(e) => onChange(e.target.value.replace(/[^\w]/g, ''), v)} placeholder="NAME" aria-label="变量名" />
      <input className="input mono" value={v} onChange={(e) => onChange(k, e.target.value)} placeholder="值，或 ${HOST_VAR}" aria-label="变量值" />
      <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onRemove} aria-label="删除变量">
        <Trash2 />
      </button>
    </>
  )
}
