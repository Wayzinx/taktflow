import { Plus } from 'lucide-react'
import { openCreateRequirement, type CreateRequirementState } from '../../lib/ui-store'
import { withShortcut } from '../ui'

/**
 * 【占位 · B 组】"新建需求"主按钮：打开全局的新建需求对话框。
 * 挂载：需求列表页头 actions（pages/requirements.tsx）；D 组可以在总览空状态里复用。
 */
export function NewRequirementButton({ size, variant = 'primary', label = '新建需求', prefill }: { size?: 'sm'; variant?: 'primary' | 'default'; label?: string; prefill?: CreateRequirementState['prefill'] }) {
  return (
    <button type="button" className={`btn${variant === 'primary' ? ' btn-primary' : ''}${size === 'sm' ? ' btn-sm' : ''}`} onClick={() => openCreateRequirement(prefill)} title={withShortcut(label, 'c')}>
      <Plus />
      {label}
    </button>
  )
}
