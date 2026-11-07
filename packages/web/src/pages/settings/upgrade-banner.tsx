import { useState } from 'react'
import { TriangleAlert, Wand2 } from 'lucide-react'
import type { SpaceUpgradePlan } from '@taktflow/core'
import { useSource } from '../../api'
import { Dialog } from '../../components/ui/dialog'
import { toast } from '../../components/ui'
import './settings-kit.css'

const KIND_LABEL: Record<SpaceUpgradePlan['changes'][number]['kind'], string> = {
  'add-file': '新增文件', 'register-workflow': '登记流程', 'drop-workflow': '移除失效引用', 'set-paths': '目录约定', 'set-default': '默认流程',
}

/** 旧版本创建的空间：说明问题，先预览要做的变更，确认后补齐（不覆盖已有文件，不动需求数据）。 */
export function UpgradeBanner({ issues, onUpgraded }: { issues: string[]; onUpgraded: () => void }) {
  const ds = useSource()
  const [plan, setPlan] = useState<SpaceUpgradePlan>()
  const [busy, setBusy] = useState(false)
  const preview = async () => {
    setBusy(true)
    try { setPlan(await ds.upgradeSpace(true, '预览空间升级')) }
    catch (e) { toast('没能生成升级计划', { body: (e as Error).message, tone: 'failed' }) }
    finally { setBusy(false) }
  }
  const apply = async () => {
    setBusy(true)
    try {
      const result = await ds.upgradeSpace(false, '升级旧版本创建的空间：补齐流程模板与默认角色')
      toast('空间已升级', { body: `${result.changes.length} 项变更，已有文件和需求数据没有改动。` })
      setPlan(undefined)
      onUpgraded()
    } catch (e) {
      toast('升级失败', { body: (e as Error).message, tone: 'failed' })
    } finally { setBusy(false) }
  }
  return (
    <div className="sk-banner" role="status">
      <TriangleAlert aria-hidden />
      <div className="sk-banner-text">
        <b>这个空间由旧版本创建，需要升级才能用标准流程</b>
        <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
      </div>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => void preview()} disabled={busy}>
        <Wand2 />
        {busy && !plan ? '检查中…' : '升级空间'}
      </button>
      <Dialog
        open={!!plan}
        onClose={() => setPlan(undefined)}
        title="升级空间"
        description="补齐流程模板和缺少的默认角色、修正失效引用。不会覆盖你改过的文件，也不动需求和运行记录；配置修改可在修改记录里撤回。"
        footer={<>
          <button type="button" className="btn btn-sm" onClick={() => setPlan(undefined)}>取消</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void apply()} disabled={busy || !plan?.changes.length}>{busy ? '升级中…' : `执行 ${plan?.changes.length ?? 0} 项变更`}</button>
        </>}
      >
        {plan && (plan.changes.length === 0 ? <p className="faint">没有需要升级的内容。</p> : (
          <ul className="sk-plan">
            {plan.changes.map((c, i) => (
              <li key={i}><span className="chip">{KIND_LABEL[c.kind]}</span><span className="mono">{c.target}</span><span className="faint">{c.detail}</span></li>
            ))}
          </ul>
        ))}
      </Dialog>
    </div>
  )
}
