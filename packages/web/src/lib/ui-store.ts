import { useEffect, useSyncExternalStore } from 'react'
import type { ProposalStep, StewardContextRef } from '@taktflow/core'

/**
 * 全局界面状态（M4 骨架）：停靠面板、新建需求 / 新建空间对话框、侧栏收起、管家未读数、workflow 幽灵预览。
 * 每一项都是"模块级值 + 订阅"，任何组件都能 open / 读，不需要 Provider。
 * 归属：store 本身是共享文件（汇总改）；读写它的组件各归各组。
 */

function createStore<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set(next: T | ((prev: T) => T)) {
      value = typeof next === 'function' ? (next as (p: T) => T)(value) : next
      subs.forEach((f) => f())
    },
    subscribe(f: () => void) {
      subs.add(f)
      return () => {
        subs.delete(f)
      }
    },
  }
}

function useStore<T>(s: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get)
}

// ---------------------------------------------------------------- 管家停靠面板（A 组实现面板，骨架提供开关）

export interface StewardDockState {
  open: boolean
  /** 打开时预填到输入框的问题（页头建议、⌘K "问管家"、空状态"让管家帮我"）。 */
  prefill?: string
  /** 调用方额外带上的上下文；面板还会自动带上当前页的上下文（usePageContext）。 */
  context?: StewardContextRef[]
  /** 直接打开某个会话。 */
  threadId?: string
  /** prefill 直接发出（⌘K「问管家：…」选项本身就是动作），而不是只填进输入框等人再按回车。 */
  send?: boolean
  /** 每次 openSteward 自增：同样的 prefill 再次点击也能被面板识别为新请求。 */
  nonce: number
}

const dock = createStore<StewardDockState>({ open: false, nonce: 0 })

export function openSteward(opts: { prefill?: string; context?: StewardContextRef[]; threadId?: string; send?: boolean } = {}) {
  dock.set((s) => ({ open: true, prefill: opts.prefill, context: opts.context, threadId: opts.threadId, send: opts.send, nonce: s.nonce + 1 }))
}
/** 让管家回答 / 代办一件事：打开停靠面板并预填问题；send 时直接发出。 */
export const askSteward = (text: string, context?: StewardContextRef[], opts: { send?: boolean } = {}) => openSteward({ prefill: text, context, send: opts.send })
export const closeSteward = () => dock.set((s) => ({ ...s, open: false }))
export const toggleSteward = () => (dock.get().open ? closeSteward() : openSteward())
export const useStewardDock = () => useStore(dock)

// ---------------------------------------------------------------- 页面上下文：停靠面板自动带上的标签

const extraContext = createStore<StewardContextRef[]>([])

/**
 * 页面声明额外的上下文（例如 workflow 编辑器里选中的节点）；卸载时清掉。
 * 空间 / 需求 / 运行 / workflow / 知识库由路由自动推导，不需要声明（见 components/steward/context.ts，A 组）。
 */
export function usePageContext(refs: StewardContextRef[], deps: unknown[]) {
  useEffect(() => {
    extraContext.set(refs)
    return () => extraContext.set([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
export const usePageContextExtra = () => useStore(extraContext)

// ---------------------------------------------------------------- 管家未读数（侧栏管家按钮的角标；数据来自 /api/steward/stream 的 unread）

const unread = createStore(0)
export const setStewardUnread = (n: number) => unread.set(Math.max(0, n))
export const useStewardUnread = () => useStore(unread)

// ---------------------------------------------------------------- 新建需求对话框（B 组实现；入口：侧栏 +、需求页主按钮、总览空状态、C 键、⌘K、管家）

export interface CreateRequirementState {
  open: boolean
  prefill?: { title?: string; description?: string; workflowId?: string }
  nonce: number
}
const createReq = createStore<CreateRequirementState>({ open: false, nonce: 0 })
export function openCreateRequirement(prefill?: CreateRequirementState['prefill']) {
  createReq.set((s) => ({ open: true, prefill, nonce: s.nonce + 1 }))
}
export const closeCreateRequirement = () => createReq.set((s) => ({ ...s, open: false }))
export const useCreateRequirement = () => useStore(createReq)

// ---------------------------------------------------------------- 新建空间对话框（B 组实现；入口：切换器底部、/spaces 页）

export interface CreateSpaceState {
  open: boolean
  /** 预选"复制已有空间"。 */
  copyFrom?: string
  nonce: number
}
const createSpace = createStore<CreateSpaceState>({ open: false, nonce: 0 })
export function openCreateSpace(opts: { copyFrom?: string } = {}) {
  createSpace.set((s) => ({ open: true, copyFrom: opts.copyFrom, nonce: s.nonce + 1 }))
}
export const closeCreateSpace = () => createSpace.set((s) => ({ ...s, open: false }))
export const useCreateSpace = () => useStore(createSpace)

// ---------------------------------------------------------------- 侧栏收起（⌘B），按浏览器记住

const SIDEBAR_KEY = 'takt.sidebar.collapsed'
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}
const collapsed = createStore(readCollapsed())
export function toggleSidebar() {
  collapsed.set((v) => !v)
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed.get() ? '1' : '0')
  } catch {
    // 隐私模式：只在本页生效
  }
}
export const useSidebarCollapsed = () => useStore(collapsed)

// ---------------------------------------------------------------- workflow 提案的画布幽灵预览（A 组：提案卡写入，编辑器读出并传给画布）

export type WorkflowStep = Extract<ProposalStep, { kind: 'workflow' }>
export interface WorkflowPreview {
  workflowId: string
  proposalId: string
  step: WorkflowStep
  /** 提案所在的管家会话，画布上"去决定"据此打开停靠面板。 */
  threadId?: string
}
const preview = createStore<WorkflowPreview | undefined>(undefined)
/** 传 undefined 清除预览。 */
export const previewWorkflowProposal = (p: WorkflowPreview | undefined) => preview.set(p)
export function useWorkflowPreview(workflowId: string): WorkflowPreview | undefined {
  const p = useStore(preview)
  return p && p.workflowId === workflowId ? p : undefined
}
