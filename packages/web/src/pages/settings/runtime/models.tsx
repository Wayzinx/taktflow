import { useRef, useState } from 'react'
import { Boxes, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ModelConfig, ModelInfo, RuntimeTestResult } from '@taktflow/core'
import { EmptyState, ErrorState, Menu, ReasonDialog, Segmented, SkeletonRows, toast, useFlashRows, useStagger } from '../../../components/ui'
import { ModelsTable } from '../models-table'
import { EditorDrawer, Field, TestButton, TestOutcome, type RuntimeApi } from './shared'

interface Draft {
  alias: string
  provider: string
  id: string
  kind: 'chat' | 'embedding'
  dimensions: string
  contextWindow: string
  priceIn: string
  priceOut: string
}

const num = (s: string) => (s.trim() === '' ? undefined : Number(s))
const numBad = (s: string) => s.trim() !== '' && !(Number(s) >= 0)

function ModelDrawer({ rt, editing, open, onClose }: { rt: RuntimeApi; editing?: string; open: boolean; onClose: () => void }) {
  const cfg = rt.cfg!
  const init = (): Draft => {
    const m = editing ? cfg.models[editing] : undefined
    return {
      alias: editing ?? '',
      provider: m?.provider ?? Object.keys(cfg.providers)[0] ?? '',
      id: m?.id ?? '',
      kind: m?.kind ?? 'chat',
      dimensions: m?.dimensions?.toString() ?? '',
      contextWindow: m?.contextWindow?.toString() ?? '',
      priceIn: m?.price?.input?.toString() ?? '',
      priceOut: m?.price?.output?.toString() ?? '',
    }
  }
  const [d, setD] = useState<Draft>(init)
  // 每次打开按当前值重填（抽屉常驻，关闭时保留退出动画）
  const [openKey, setOpenKey] = useState(open)
  if (open !== openKey) {
    setOpenKey(open)
    if (open) setD(init())
  }
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))
  const aliasBad = !editing && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.alias) || Boolean(cfg.models[d.alias]))
  const priced = d.priceIn.trim() !== '' || d.priceOut.trim() !== ''
  const canSave =
    Boolean(d.alias) && !aliasBad && Boolean(cfg.providers[d.provider]) && Boolean(d.id.trim()) &&
    !numBad(d.contextWindow) && !numBad(d.priceIn) && !numBad(d.priceOut) && !(d.kind === 'embedding' && !(Number(d.dimensions) > 0))
  const providers = Object.keys(cfg.providers).sort()

  const save = async (reason: string) => {
    const old = editing ? cfg.models[editing] : undefined
    const next: ModelConfig = {
      provider: d.provider,
      id: d.id.trim(),
      ...(d.kind === 'embedding' ? { kind: 'embedding', dimensions: Number(d.dimensions) } : {}),
      ...(num(d.contextWindow) ? { contextWindow: num(d.contextWindow) } : {}),
      ...(priced ? { price: { input: num(d.priceIn) ?? 0, output: num(d.priceOut) ?? 0, ...(old?.price?.cachedInput !== undefined ? { cachedInput: old.price.cachedInput } : {}) } } : {}),
    }
    await rt.patch({ models: { [d.alias]: next } }, reason)
    toast(editing ? `模型 ${d.alias} 已更新` : `已添加模型 ${d.alias}`, { body: '角色和节点里用别名引用它。' })
  }

  return (
    <EditorDrawer open={open} onClose={onClose} title={editing ? `编辑模型 ${editing}` : '添加模型'} description="模型别名 = provider + 厂商模型 ID。角色、节点、Lead 和管家都用别名引用。" canSave={canSave} onSave={save} onReload={rt.reload}>
      <Field label="别名" req hint={editing ? '改名请删掉重加' : '短一点，角色里要写它'}>
        <input className={`input mono${aliasBad && d.alias ? ' is-bad' : ''}`} value={d.alias} disabled={Boolean(editing)} placeholder="deepseek-v4" onChange={(e) => set({ alias: e.target.value.trim() })} />
        {aliasBad && d.alias && <span className="rt-field-err">{cfg.models[d.alias] ? `已经有 ${d.alias} 了` : '只能用字母、数字、. - _'}</span>}
      </Field>
      <Field label="Provider" req>
        {providers.length ? (
          <select className="select mono" value={d.provider} onChange={(e) => set({ provider: e.target.value })}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p} · {cfg.providers[p]!.protocol}
              </option>
            ))}
          </select>
        ) : (
          <span className="rt-note">还没有 provider：先在上面的 Provider 卡片里加一个。</span>
        )}
      </Field>
      <Field label="厂商模型 ID" req hint="provider 那边的模型名">
        <input className="input mono" value={d.id} placeholder="deepseek-chat" onChange={(e) => set({ id: e.target.value })} />
      </Field>
      <Field label="类型">
        <Segmented<Draft['kind']>
          value={d.kind}
          onChange={(v) => set({ kind: v })}
          size="sm"
          ariaLabel="模型类型"
          options={[
            { value: 'chat', label: '对话' },
            { value: 'embedding', label: '向量（知识库）' },
          ]}
        />
      </Field>
      {d.kind === 'embedding' ? (
        <Field label="向量维度" req>
          <input className="input mono num" inputMode="numeric" value={d.dimensions} placeholder="1536" onChange={(e) => set({ dimensions: e.target.value })} />
        </Field>
      ) : (
        <Field label="上下文窗口" hint="token 数，用于上下文曲线与压缩提示">
          <input className={`input mono num${numBad(d.contextWindow) ? ' is-bad' : ''}`} inputMode="numeric" value={d.contextWindow} placeholder="128000" onChange={(e) => set({ contextWindow: e.target.value })} />
        </Field>
      )}
      <Field label="价格" hint="$ / 1M token；不填则成本记为未定价">
        <div className="rt-pair">
          <input className={`input mono num${numBad(d.priceIn) ? ' is-bad' : ''}`} inputMode="decimal" value={d.priceIn} placeholder="输入" aria-label="输入价格" onChange={(e) => set({ priceIn: e.target.value })} />
          <span className="faint">/</span>
          <input className={`input mono num${numBad(d.priceOut) ? ' is-bad' : ''}`} inputMode="decimal" value={d.priceOut} placeholder="输出" aria-label="输出价格" onChange={(e) => set({ priceOut: e.target.value })} />
        </div>
      </Field>
    </EditorDrawer>
  )
}

/** 模型表 + 增删改 + 测试（会计费，要确认）。 */
export function ModelsCard({ rt, models, error, reload }: { rt: RuntimeApi; models?: ModelInfo[]; error?: Error; reload: () => void }) {
  const cfg = rt.cfg
  const [drawer, setDrawer] = useState<{ open: boolean; editing?: string }>({ open: false })
  const [results, setResults] = useState<Record<string, RuntimeTestResult | undefined>>({})
  const [removing, setRemoving] = useState<string>()
  const [menu, setMenu] = useState<string>()
  const menuBtn = useRef<HTMLButtonElement | null>(null)
  const flash = useFlashRows((models ?? []).map((m) => m.alias))
  const st = useStagger(models?.length ?? 0)
  const usedBy = (alias: string) => {
    if (!cfg) return []
    const roles = Object.entries(cfg.roles).filter(([, s]) => s.model === alias || s.fallback?.some((f) => f.model === alias)).map(([r]) => r)
    const sys = Object.entries(cfg.system).filter(([, s]) => s?.model === alias).map(([r]) => r)
    return [...roles, ...sys]
  }
  const canEdit = Boolean(cfg)

  return (
    <div className="card rt-card">
      <div className="card-head">
        <span className="card-title">模型</span>
        {models && <span className="faint num">{models.length}</span>}
        <span className="spacer" />
        <span className="faint models-note">别名在角色和节点里引用；价格用于成本统计</span>
        {canEdit && (
          <button type="button" className="btn btn-sm" onClick={() => setDrawer({ open: true })} disabled={!Object.keys(cfg!.providers).length} title={Object.keys(cfg!.providers).length ? undefined : '先加一个 provider'}>
            <Plus aria-hidden /> 添加模型
          </button>
        )}
      </div>
      {error && !models ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !models ? (
        <SkeletonRows rows={6} />
      ) : models.length === 0 ? (
        <EmptyState compact icon={Boxes} title="还没有配置模型" body="加一个模型别名后，角色和节点就能按别名引用它；密钥只显示来源，不保存明文到空间。" action={canEdit && Object.keys(cfg!.providers).length ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setDrawer({ open: true })}>添加模型</button> : undefined} />
      ) : (
        <ModelsTable
          models={models}
          rowClass={(m, i) => {
            const s = st(i)
            return { className: [flash(m.alias), s.className].filter(Boolean).join(' ') || undefined, style: s.style }
          }}
          below={(m) => (results[m.alias] ? <TestOutcome r={results[m.alias]!} /> : null)}
          actions={
            canEdit
              ? (m) => (
                  <span className="rt-row-acts">
                    <TestButton target={{ kind: 'model', alias: m.alias }} onResult={(x) => setResults((r) => ({ ...r, [m.alias]: x }))} ghost />
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-icon"
                      aria-label={`${m.alias} 的更多操作`}
                      onClick={(e) => {
                        menuBtn.current = e.currentTarget
                        setMenu(m.alias)
                      }}
                    >
                      <MoreHorizontal />
                    </button>
                  </span>
                )
              : undefined
          }
        />
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
                { id: 'del', label: '删除模型', icon: Trash2, danger: true, separator: true, onSelect: () => setRemoving(menu) },
              ]
            : []
        }
      />
      {cfg && <ModelDrawer rt={rt} editing={drawer.editing} open={drawer.open} onClose={() => setDrawer((x) => ({ ...x, open: false }))} />}
      <ReasonDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        risk="dangerous"
        title={`删除模型 ${removing ?? ''}`}
        description={removing && usedBy(removing).length ? `还在用它：${usedBy(removing).join('、')}。删除后这些角色会用 harness 的默认模型。` : '没有角色或系统角色在用它。'}
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await rt.patch({ models: { [removing!]: null } }, reason)
          toast(`已删除模型 ${removing}`)
        }}
      />
    </div>
  )
}
