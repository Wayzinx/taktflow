import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { Cable, ChevronDown, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CatalogList, ProviderConfig, RuntimeTestResult } from '@taktflow/core'
import { invalidate, useSource } from '../../../api'
import { useRuntimeCatalog } from '../../../components/harness-picker/use-catalog'
import { fmtRelative } from '../../../lib/format'
import { EmptyState, Menu, ReasonDialog, Segmented, Skeleton, toast, useFlashRows, useStagger } from '../../../components/ui'
import { protocolColor } from '../../../lib/capabilities'
import { EditorDrawer, Field, KeySource, SECRET, TestButton, TestOutcome, type RuntimeApi } from './shared'

const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini'] as const
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

interface Draft {
  id: string
  preset: string
  protocol: string
  baseURL: string
  apiKeyEnv: string
  keyMode: 'env' | 'local'
  secret: string
}

/** 新增 / 编辑 provider：选预设自动填地址、协议和建议的环境变量名；密钥选环境变量或本机密钥库。 */
function ProviderDrawer({ rt, editing, open, onClose }: { rt: RuntimeApi; editing?: string; open: boolean; onClose: () => void }) {
  const ds = useSource()
  const cfg = rt.cfg!
  const init = (): Draft => {
    const p = editing ? cfg.providers[editing] : undefined
    const src = p?.apiKeyEnv ? cfg.keys[p.apiKeyEnv] : undefined
    return { id: editing ?? '', preset: p?.preset ?? '', protocol: p?.protocol ?? 'openai-chat', baseURL: p?.baseURL ?? '', apiKeyEnv: p?.apiKeyEnv ?? '', keyMode: src === 'local' ? 'local' : 'env', secret: '' }
  }
  const [d, setD] = useState<Draft>(init)
  const [openKey, setOpenKey] = useState(open)
  if (open !== openKey) {
    setOpenKey(open)
    if (open) setD(init())
  }
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))
  const preset = cfg.presets.providers.find((p) => p.id === d.preset)
  const pickPreset = (id: string) => {
    const p = cfg.presets.providers.find((x) => x.id === id)
    if (!p) return set({ preset: '' })
    set({ preset: id, protocol: p.protocol, baseURL: '', apiKeyEnv: p.apiKeyEnv ?? '', id: d.id || (cfg.providers[id] ? '' : id) })
  }
  const src = d.apiKeyEnv ? cfg.keys[d.apiKeyEnv] : undefined
  const idBad = !editing && (!/^[a-z0-9][a-z0-9_-]*$/.test(d.id) || Boolean(cfg.providers[d.id]))
  const envBad = Boolean(d.apiKeyEnv) && !ENV_NAME.test(d.apiKeyEnv)
  const needSecret = d.keyMode === 'local' && Boolean(d.apiKeyEnv) && src !== 'local' && src !== 'env' && !d.secret
  const canSave = Boolean(d.id) && !idBad && !envBad && Boolean(d.protocol) && (Boolean(preset?.baseURL) || Boolean(d.baseURL.trim())) && !needSecret

  const save = async (reason: string) => {
    if (d.keyMode === 'local' && d.apiKeyEnv && d.secret) await ds.putSecret(d.apiKeyEnv, d.secret, reason)
    const next: ProviderConfig = {
      protocol: d.protocol,
      ...(d.preset ? { preset: d.preset } : {}),
      ...(d.baseURL.trim() ? { baseURL: d.baseURL.trim() } : {}),
      ...(d.apiKeyEnv ? { apiKeyEnv: d.apiKeyEnv } : {}),
      ...(editing && cfg.providers[editing]?.headers ? { headers: cfg.providers[editing]!.headers } : {}),
    }
    await rt.patch({ providers: { [d.id]: next } }, reason)
    toast(editing ? `provider ${d.id} 已更新` : `已添加 provider ${d.id}`, { body: '新开的节点、Lead 和管家马上用新配置；正在跑的节点不受影响。' })
  }

  return (
    <EditorDrawer open={open} onClose={onClose} title={editing ? `编辑 provider ${editing}` : '添加 provider'} description="provider 是一个模型 API 的入口：地址、协议、密钥。模型别名挂在 provider 下面。" canSave={canSave} onSave={save} onReload={rt.reload}>
      <Field label="预设" hint="选了自动填地址、协议和建议的环境变量名">
        <div className="rt-presets" role="radiogroup" aria-label="provider 预设">
          {cfg.presets.providers.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={d.preset === p.id} className={`rt-preset${d.preset === p.id ? ' on' : ''}`} onClick={() => pickPreset(d.preset === p.id ? '' : p.id)}>
              {p.displayName}
            </button>
          ))}
        </div>
      </Field>
      <Field label="ID" req hint={editing ? '改名请删掉重加' : '模型里用它引用这个 provider'}>
        <input className={`input mono${idBad && d.id ? ' is-bad' : ''}`} value={d.id} disabled={Boolean(editing)} placeholder="deepseek" onChange={(e) => set({ id: e.target.value.trim() })} />
        {idBad && d.id && <span className="rt-field-err">{cfg.providers[d.id] ? `已经有 ${d.id} 了：换一个 ID，或编辑原来那个` : '只能用小写字母、数字、- 和 _'}</span>}
      </Field>
      <Field label="协议" req>
        <Segmented<string> value={d.protocol} onChange={(v) => set({ protocol: v })} size="sm" ariaLabel="协议" options={PROTOCOLS.map((p) => ({ value: p, label: p }))} />
      </Field>
      <Field label="地址" req={!preset?.baseURL} hint={preset?.baseURL ? `留空用预设：${preset.baseURL}` : undefined}>
        <input className="input mono" value={d.baseURL} placeholder={preset?.baseURL ?? 'https://…/v1'} onChange={(e) => set({ baseURL: e.target.value })} />
      </Field>
      <Field label="密钥环境变量名" hint="只记名字；本地模型（Ollama 等）可以留空">
        <input className={`input mono${envBad ? ' is-bad' : ''}`} value={d.apiKeyEnv} placeholder={preset?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'} onChange={(e) => set({ apiKeyEnv: e.target.value.trim().toUpperCase() })} />
        {envBad && <span className="rt-field-err">只能用大写字母、数字和下划线，且不能以数字开头</span>}
        {d.apiKeyEnv && !envBad && (
          <span className="rt-key-now">
            现在：<KeySource name={d.apiKeyEnv} source={src} />
          </span>
        )}
      </Field>
      {d.apiKeyEnv && !envBad && (
        <Field label="密钥从哪来">
          <Segmented<Draft['keyMode']>
            value={d.keyMode}
            onChange={(v) => set({ keyMode: v })}
            size="sm"
            ariaLabel="密钥来源"
            options={[
              { value: 'env', label: SECRET.env.label },
              { value: 'local', label: SECRET.local.label },
            ]}
          />
          {d.keyMode === 'env' ? (
            <span className="rt-note">在启动 serve 的终端里设置 <code>{d.apiKeyEnv}</code>；环境变量优先于本机密钥库。</span>
          ) : (
            <>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={d.secret}
                placeholder={src === 'local' ? '已存在本机：留空不改' : src === 'env' ? '环境变量里已有，存本机只作后备' : '粘贴密钥'}
                onChange={(e) => set({ secret: e.target.value })}
              />
              <span className="rt-note">只存这台机器的本机密钥库（文件权限 0600），不进空间目录与 git；保存后任何接口都不会再显示它。</span>
            </>
          )}
        </Field>
      )}
    </EditorDrawer>
  )
}

/** provider 表：地址、协议、密钥来源，每行能测（只列模型，不计费）、编辑、删除。 */
const SOURCE: Record<CatalogList['source'], string> = { live: '刚从上游列出', cache: '缓存', preset: '预设清单' }

/** provider 行下面的一行：上游列出了几个模型、什么时候列的，能刷新、能展开看全部（docs/design/32 §3）。 */
function ProviderModels({ id, list, onRefreshed }: { id: string; list?: CatalogList; onRefreshed: () => void }) {
  const ds = useSource()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!list) return null
  // ux-audit: ok 和服务端「还在列」的占位错误比对，不是界面文案
  const loading = list.error === '正在获取…'
  const live = list.models.filter((m) => !m.deprecated)
  const gone = list.models.length - live.length
  const refresh = async () => {
    setBusy(true)
    try {
      const r = await ds.refreshCatalog({ kind: 'provider', id })
      onRefreshed()
      toast(r.error ? `${id}：没列出来` : `${id}：列出 ${r.models.length} 个模型`, { body: r.error })
    } catch (e) {
      toast(`${id}：刷新失败`, { body: e instanceof Error ? e.message : undefined })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rt-pmodels">
      {loading ? (
        <Skeleton w={120} h={12} />
      ) : (
        <button type="button" className="rt-pm-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)} disabled={!list.models.length}>
          <b className="num">{live.length}</b> 个模型
          {gone > 0 && <span className="faint">（另有 {gone} 个已下架）</span>}
          {list.models.length > 0 && <ChevronDown className={open ? 'is-open' : undefined} aria-hidden />}
        </button>
      )}
      {!loading && (
        <span className={`faint${list.error ? ' rt-pm-err' : ''}`} title={list.error}>
          {list.error ? (list.source === 'preset' ? `没列出来，用的${SOURCE.preset}：${list.error}` : `刷新失败，显示上次结果：${list.error}`) : `${SOURCE[list.source]}${list.fetchedAt ? ` · ${fmtRelative(list.fetchedAt)}` : ''}`}
        </span>
      )}
      <button type="button" className="btn btn-sm btn-ghost btn-icon rt-pm-refresh" aria-label={`重新列出 ${id} 的模型`} title="重新列出模型" aria-busy={busy || undefined} disabled={busy || loading} onClick={refresh}>
        <RefreshCw className={busy ? 'spin' : undefined} />
      </button>
      {open && (
        <ul className="rt-pm-list" aria-label={`${id} 的模型`}>
          {list.models.map((m) => (
            <li key={m.id} className={`mono${m.deprecated ? ' is-gone' : ''}${m.alias ? ' is-alias' : ''}`} title={[m.label !== m.id ? m.label : '', m.alias ? `别名 ${m.alias}` : '', m.deprecated ? '上游已不再列出' : ''].filter(Boolean).join(' · ') || undefined}>
              {m.id}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ProvidersCard({ rt }: { rt: RuntimeApi }) {
  const ds = useSource()
  const cfg = rt.cfg!
  const [drawer, setDrawer] = useState<{ open: boolean; editing?: string }>({ open: false })
  const [results, setResults] = useState<Record<string, RuntimeTestResult | undefined>>({})
  const [removing, setRemoving] = useState<string>()
  const [forgetting, setForgetting] = useState<string>()
  const [menu, setMenu] = useState<string>()
  const menuBtn = useRef<HTMLButtonElement | null>(null)
  const rows = useMemo(() => Object.entries(cfg.providers).sort(([a], [b]) => a.localeCompare(b)), [cfg.providers])
  const used = (id: string) => Object.entries(cfg.models).filter(([, m]) => m.provider === id).map(([a]) => a)
  const flash = useFlashRows(rows.map(([id]) => id))
  const st = useStagger(rows.length)
  const presetName = (p: ProviderConfig) => cfg.presets.providers.find((x) => x.id === p.preset)?.displayName
  const catalog = useRuntimeCatalog()

  return (
    <div className="card rt-card">
      <div className="card-head">
        <span className="card-title">Provider</span>
        <span className="faint num">{rows.length}</span>
        <span className="spacer" />
        <span className="faint models-note">模型 API 的入口；密钥只显示来源</span>
        <button type="button" className="btn btn-sm" onClick={() => setDrawer({ open: true })}>
          <Plus aria-hidden /> 添加 provider
        </button>
      </div>
      {rows.length === 0 ? (
        <EmptyState compact icon={Cable} title="还没有 provider" body="加一个模型 API（DeepSeek、OpenAI、本机 Ollama…），再给它挂模型别名。" action={<button type="button" className="btn btn-sm btn-primary" onClick={() => setDrawer({ open: true })}>添加 provider</button>} />
      ) : (
        <ul className="rt-rows" aria-label="provider 列表">
          {rows.map(([id, p], i) => {
            const r = results[id]
            const s = st(i)
            const base = p.baseURL ?? cfg.presets.providers.find((x) => x.id === p.preset)?.baseURL
            return (
              <li key={id} className={`rt-row ${flash(id)} ${s.className ?? ''}`} style={s.style}>
                <div className="rt-row-main">
                  <div className="rt-row-name">
                    <span className="mono rt-id">{id}</span>
                    {presetName(p) && <span className="chip">{presetName(p)}</span>}
                  </div>
                  <span className="proto-pill mono" style={{ '--proto': protocolColor(p.protocol) } as CSSProperties}>
                    {p.protocol}
                  </span>
                  <span className="mono faint truncate rt-url" title={base}>
                    {base ?? '未填地址'}
                  </span>
                  <KeySource name={p.apiKeyEnv} source={p.apiKeyEnv ? cfg.keys[p.apiKeyEnv] : undefined} />
                  <span className="rt-row-acts">
                    <TestButton target={{ kind: 'provider', id }} onResult={(x) => setResults((m) => ({ ...m, [id]: x }))} ghost />
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-icon"
                      aria-label={`${id} 的更多操作`}
                      onClick={(e) => {
                        menuBtn.current = e.currentTarget
                        setMenu(id)
                      }}
                    >
                      <MoreHorizontal />
                    </button>
                  </span>
                </div>
                <ProviderModels id={id} list={catalog.data?.providers.find((x) => x.id === id)?.models} onRefreshed={catalog.reload} />
                {r && <TestOutcome r={r} />}
              </li>
            )
          })}
        </ul>
      )}
      <Menu
        open={Boolean(menu)}
        onClose={() => setMenu(undefined)}
        anchor={menuBtn}
        placement="bottom-end"
        items={
          menu
            ? [
                { id: 'edit', label: '编辑', icon: Pencil, onSelect: () => setDrawer({ open: true, editing: menu }) },
                ...(cfg.providers[menu]?.apiKeyEnv && cfg.keys[cfg.providers[menu]!.apiKeyEnv!] === 'local'
                  ? [{ id: 'forget', label: '从本机密钥库删除密钥', icon: Trash2, onSelect: () => setForgetting(cfg.providers[menu]!.apiKeyEnv) }]
                  : []),
                { id: 'del', label: '删除 provider', icon: Trash2, danger: true, separator: true, onSelect: () => setRemoving(menu) },
              ]
            : []
        }
      />
      <ProviderDrawer rt={rt} editing={drawer.editing} open={drawer.open} onClose={() => setDrawer((x) => ({ ...x, open: false }))} />
      <ReasonDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        risk="dangerous"
        title={`删除 provider ${removing ?? ''}`}
        description={
          removing && used(removing).length
            ? `还有模型挂在它下面：${used(removing).join('、')}。先把这些模型改到别的 provider 或删掉，否则保存会被拒绝。`
            : '删除后引用它的模型会失效；本机密钥库里的密钥不会一起删。'
        }
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await rt.patch({ providers: { [removing!]: null } }, reason)
          toast(`已删除 provider ${removing}`)
        }}
      />
      <ReasonDialog
        open={Boolean(forgetting)}
        onClose={() => setForgetting(undefined)}
        risk="dangerous"
        title={`删除本机密钥 ${forgetting ?? ''}`}
        description="只删这台机器本机密钥库里的这一项；环境变量里如果有，仍然会用环境变量。"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          const r = await ds.deleteSecret(forgetting!, reason)
          invalidate()
          toast(`本机密钥 ${r.name} 已删除`, { body: `现在的来源：${SECRET[r.source].label}` })
        }}
      />
    </div>
  )
}
