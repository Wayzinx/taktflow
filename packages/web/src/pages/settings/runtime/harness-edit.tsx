import { useState } from 'react'
import { Plus, Power, X } from 'lucide-react'
import type { AcpHarnessConfig, CliHarnessConfig, HarnessInfo, HarnessOverride } from '@taktflow/core'
import { Segmented, toast } from '../../../components/ui'
import { EditorDrawer, Field, type RuntimeApi } from './shared'

/** 服务端遮盖过的环境变量值：原样提交表示"不改"。 */
export const MASK = '[REDACTED]'
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

type EnvRow = { k: string; v: string }
const toRows = (env?: Record<string, string>): EnvRow[] => Object.entries(env ?? {}).map(([k, v]) => ({ k, v }))
const toEnv = (rows: EnvRow[]): Record<string, string> | undefined => {
  const out = Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]))
  return Object.keys(out).length ? out : undefined
}
/** 名字像密钥的变量不能把值写进空间配置（服务端同一条规则）：改用环境变量或本机密钥库。 */
const SECRETISH = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE)/i
const secretRow = (r: EnvRow) => SECRETISH.test(r.k) && r.v !== MASK && r.v !== ''
const envBad = (rows: EnvRow[]) => rows.some((r) => (r.k.trim() && !ENV_NAME.test(r.k.trim())) || secretRow(r))

/** 'npx --no-install "@a/b c"' → ['npx', '--no-install', '@a/b c']：只认双引号 / 单引号，不做变量展开。 */
export function splitCommand(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}
export const joinCommand = (parts: string[]) => parts.map((p) => (/[\s"]/.test(p) ? `'${p}'` : p)).join(' ')

function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  return (
    <div className="rt-env">
      {rows.map((r, i) => (
        <div key={i} className="rt-env-row">
          <input className={`input mono${r.k.trim() && !ENV_NAME.test(r.k.trim()) ? ' is-bad' : ''}`} aria-label="变量名" value={r.k} placeholder="NAME" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, k: e.target.value.toUpperCase() } : x)))} />
          <input
            className="input mono"
            aria-label={`${r.k || '变量'} 的值`}
            type={r.v === MASK ? 'password' : 'text'}
            value={r.v === MASK ? '' : r.v}
            placeholder={r.v === MASK ? '已设置（不显示）：留空不改' : '值'}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, v: e.target.value || (rows[i]!.v === MASK ? MASK : '') } : x)))}
          />
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`去掉 ${r.k || '这一行'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X />
          </button>
        </div>
      ))}
      {rows.some(secretRow) && (
        <span className="rt-field-err">
          {rows.filter(secretRow).map((r) => r.k).join('、')} 看起来是密钥，值不能写进空间配置：在启动 serve 的终端里设置同名环境变量，或在 Provider 里存到本机密钥库。
        </span>
      )}
      <button type="button" className="btn btn-sm btn-ghost rt-add-fallback" onClick={() => onChange([...rows, { k: '', v: '' }])}>
        <Plus aria-hidden /> 加一个环境变量
      </button>
    </div>
  )
}

/** 内置 Harness：可执行文件路径、额外环境变量、在本空间停用。 */
export function OverrideDrawer({ rt, h, open, onClose }: { rt: RuntimeApi; h?: HarnessInfo; open: boolean; onClose: () => void }) {
  const init = () => {
    const o = h ? rt.cfg?.harnessOverrides[h.id] : undefined
    return { command: o?.command ?? '', env: toRows(o?.env), disabled: Boolean(o?.disabled) }
  }
  const [d, setD] = useState(init)
  const [openKey, setOpenKey] = useState(open)
  if (open !== openKey) {
    setOpenKey(open)
    if (open) setD(init())
  }
  if (!h) return null
  const used = h.roles
  const save = async (reason: string) => {
    const o: HarnessOverride = { ...(d.command.trim() ? { command: d.command.trim() } : {}), ...(toEnv(d.env) ? { env: toEnv(d.env) } : {}), ...(d.disabled ? { disabled: true } : {}) }
    await rt.patch({ harnessOverrides: { [h.id]: Object.keys(o).length ? o : null } }, reason)
    toast(`${h.displayName} 的设置已更新`, { body: d.disabled ? '本空间里不会再路由到它。' : '新开的节点马上用新设置。' })
  }
  const defaultCmd = h.override?.command ? undefined : h.command?.[0]
  return (
    <EditorDrawer open={open} onClose={onClose} title={`设置 ${h.displayName}`} description="只影响本空间；改完不用重启 serve，正在跑的节点不受影响。" canSave={!envBad(d.env) && !(d.disabled && used.length > 0)} onSave={save} onReload={rt.reload}>
      <Field label="可执行文件" hint={defaultCmd ? `留空用 PATH 里的 ${defaultCmd}` : '留空用 PATH 里的默认命令'}>
        <input className="input mono" value={d.command} placeholder={defaultCmd ? `/usr/local/bin/${defaultCmd}` : '/path/to/bin'} onChange={(e) => setD((x) => ({ ...x, command: e.target.value }))} />
        <span className="rt-note">装在非标准位置、或想固定某个版本时填绝对路径；相对路径按空间目录解析。</span>
      </Field>
      <Field label="额外环境变量" hint="合并进这个 Harness 的进程环境">
        <EnvEditor rows={d.env} onChange={(env) => setD((x) => ({ ...x, env }))} />
      </Field>
      <Field label="在本空间停用">
        <button type="button" role="switch" aria-checked={d.disabled} className={`rt-switch${d.disabled ? ' on' : ''}`} onClick={() => setD((x) => ({ ...x, disabled: !x.disabled }))}>
          <span className="rt-switch-knob" aria-hidden />
          <Power aria-hidden />
          {d.disabled ? '已停用：路由和探测都看不到它' : '启用中'}
        </button>
        {d.disabled && used.length > 0 && <span className="rt-field-err">还有角色在用它：{used.join('、')}。先把这些角色改到别的 Harness，再停用。</span>}
      </Field>
    </EditorDrawer>
  )
}

type Kind = 'acp' | 'cli'

/** 添加 / 编辑自定义 harness：ACP（选预设或填命令）或声明式 CLI。 */
export function CustomHarnessDrawer({ rt, editing, open, onClose }: { rt: RuntimeApi; editing?: string; open: boolean; onClose: () => void }) {
  const cfg = rt.cfg!
  const presets = cfg.presets.acp
  const init = () => {
    const cur = editing ? cfg.harnesses.find((h) => h.id === editing) : undefined
    return {
      kind: (cur?.kind ?? 'acp') as Kind,
      id: cur?.id ?? '',
      displayName: cur?.displayName ?? '',
      preset: cur?.kind === 'acp' ? (cur.preset ?? '') : '',
      command: cur?.kind === 'acp' ? (cur.command ? joinCommand(cur.command) : '') : cur?.kind === 'cli' ? joinCommand(cur.command) : '',
      permissions: (cur?.kind === 'acp' ? cur.permissions : undefined) ?? 'allow',
      promptVia: (cur?.kind === 'cli' ? cur.promptVia : undefined) ?? 'stdin',
      env: toRows(cur?.env),
    }
  }
  const [d, setD] = useState(init)
  const [openKey, setOpenKey] = useState(open)
  if (open !== openKey) {
    setOpenKey(open)
    if (open) setD(init())
  }
  const set = (p: Partial<ReturnType<typeof init>>) => setD((x) => ({ ...x, ...p }))
  const cur = editing ? cfg.harnesses.find((h) => h.id === editing) : undefined
  const taken = (id: string) => !editing && (cfg.harnesses.some((h) => h.id === id) || BUILTIN_IDS.has(id))
  const idBad = !/^[a-z0-9][a-z0-9_-]*$/.test(d.id) || taken(d.id)
  const preset = presets.find((p) => p.id === d.preset)
  const cmd = splitCommand(d.command)
  const canSave = Boolean(d.id) && !idBad && !envBad(d.env) && (d.kind === 'acp' ? Boolean(preset) || cmd.length > 0 : cmd.length > 0)
  const pick = (id: string) => {
    const p = presets.find((x) => x.id === id)
    set({ preset: id, id: d.id || (taken(id) || BUILTIN_IDS.has(id) ? `${id}-acp` : id), displayName: d.displayName || (p?.displayName ?? '') })
  }

  const save = async (reason: string) => {
    const env = toEnv(d.env)
    const base = { id: d.id, ...(d.displayName.trim() ? { displayName: d.displayName.trim() } : {}), ...(env ? { env } : {}) }
    const next: AcpHarnessConfig | CliHarnessConfig =
      d.kind === 'acp'
        ? { ...base, kind: 'acp', ...(d.preset ? { preset: d.preset } : {}), ...(cmd.length ? { command: cmd } : {}), permissions: d.permissions }
        : { ...(cur?.kind === 'cli' ? cur : {}), ...base, kind: 'cli', command: cmd, promptVia: d.promptVia, output: cur?.kind === 'cli' ? cur.output : { format: 'text' } }
    await rt.patch({ harnesses: { [d.id]: next } }, reason)
    toast(editing ? `${d.id} 已更新` : `已添加 Harness ${d.id}`, { body: '点卡片上的「测试」看它能不能跑起来。' })
  }

  return (
    <EditorDrawer
      open={open}
      onClose={onClose}
      title={editing ? `编辑 ${editing}` : '添加 Harness'}
      description={d.kind === 'acp' ? 'ACP（Agent Client Protocol）是 agent 的开放协议：支持它的 agent 配一条启动命令就能接进来，工具调用、续会话按它声明的能力走。' : '声明式 CLI：任何能从命令行收 prompt、往 stdout 写结果的工具。只有纯文本输出，没有工具事件与用量。'}
      canSave={canSave}
      onSave={save}
      onReload={rt.reload}
      width={540}
    >
      {!editing && (
        <Field label="接入方式">
          <Segmented<Kind>
            value={d.kind}
            onChange={(kind) => set({ kind })}
            size="sm"
            ariaLabel="接入方式"
            options={[
              { value: 'acp', label: 'ACP agent（推荐）' },
              { value: 'cli', label: '声明式 CLI' },
            ]}
          />
        </Field>
      )}
      {d.kind === 'acp' && (
        <Field label="预设" hint="或者不选，直接填启动命令">
          <div className="rt-acp-grid" role="radiogroup" aria-label="ACP 预设">
            {presets.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={d.preset === p.id} className={`rt-acp${d.preset === p.id ? ' on' : ''}`} onClick={() => (d.preset === p.id ? set({ preset: '' }) : pick(p.id))}>
                <b>{p.displayName}</b>
                <span className="mono faint truncate">{joinCommand(p.command)}</span>
              </button>
            ))}
          </div>
          {preset?.install && <span className="rt-note">安装：{preset.install}</span>}
        </Field>
      )}
      <Field label="ID" req hint={editing ? '改名请删掉重加' : '默认路由和角色档案里用它'}>
        <input className={`input mono${idBad && d.id ? ' is-bad' : ''}`} value={d.id} disabled={Boolean(editing)} placeholder={d.kind === 'acp' ? 'goose' : 'aider'} onChange={(e) => set({ id: e.target.value.trim() })} />
        {idBad && d.id && <span className="rt-field-err">{taken(d.id) ? `${d.id} 已被占用（内置或已添加）：换一个` : '只能用小写字母、数字、- 和 _'}</span>}
      </Field>
      <Field label="显示名">
        <input className="input" value={d.displayName} placeholder={preset?.displayName ?? d.id} onChange={(e) => set({ displayName: e.target.value })} />
      </Field>
      <Field label="启动命令" req={d.kind === 'cli' || !preset} hint={d.kind === 'acp' ? (preset ? '留空用预设命令' : '让 agent 以 ACP 模式跑在 stdio 上') : '可用 {{prompt}} {{promptFile}} {{cwd}} {{model}}'}>
        <input className="input mono" value={d.command} placeholder={preset ? joinCommand(preset.command) : d.kind === 'acp' ? 'my-agent --acp' : 'aider --message {{prompt}} --yes-always'} onChange={(e) => set({ command: e.target.value })} />
      </Field>
      {d.kind === 'acp' ? (
        <Field label="权限请求" hint="agent 要改文件、跑命令前会来问">
          <Segmented<'allow' | 'reject'>
            value={d.permissions}
            onChange={(permissions) => set({ permissions })}
            size="sm"
            ariaLabel="权限请求"
            options={[
              { value: 'allow', label: '工作目录内放行一次' },
              { value: 'reject', label: '一律拒绝' },
            ]}
          />
          <span className="rt-note">只读运行（评审、评测）里写类请求一律拒绝；每次请求都记进运行事件。</span>
        </Field>
      ) : (
        <Field label="prompt 怎么传">
          <Segmented<'stdin' | 'arg' | 'file'>
            value={d.promptVia}
            onChange={(promptVia) => set({ promptVia })}
            size="sm"
            ariaLabel="prompt 传入方式"
            options={[
              { value: 'stdin', label: '标准输入' },
              { value: 'arg', label: '参数 {{prompt}}' },
              { value: 'file', label: '文件 {{promptFile}}' },
            ]}
          />
        </Field>
      )}
      <Field label="环境变量">
        <EnvEditor rows={d.env} onChange={(env) => set({ env })} />
      </Field>
    </EditorDrawer>
  )
}

/** 内置 Harness 的 id（自定义的不能重名）。和 packages/harness 的 createHarnesses 对齐。 */
export const BUILTIN_IDS = new Set(['native', 'mock', 'claude-code', 'codex', 'dsh', 'gemini-cli', 'cursor-agent', 'qwen-code', 'kimi-cli', 'opencode', 'pi'])
