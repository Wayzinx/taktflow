# packages/web 文件归属（M2 W2/W3 并行开发）

每个 agent 只改自己名下的文件。名下没有、又必须改的文件（尤其是 `api/**`），在交付说明里写"共享文件变更请求"，由汇总 agent 合入。路径都相对 `packages/web/src/`。

| 归属 | 文件 |
|---|---|
| **A 空间** | `pages/settings/**`、`components/space-switcher.*`、`lib/space.ts`、`pages/workflows-list*` |
| **B 群聊** | `pages/requirement/chat-tab.tsx`、`pages/requirement/chat/**` |
| **C 评审** | `pages/requirement/reviews-tab.tsx`（样式放 `reviews-tab.css`）、`pages/run/review/**`、`pages/run/dag-nodes.tsx`、`pages/run/dag-edges.tsx`、`components/event-timeline.*` |
| **D 编辑器画布** | `pages/workflow/index.tsx`、`pages/workflow/workflow.css`、`pages/workflow/canvas/**`、`pages/workflow/palette/**`、`pages/workflow/properties/**` |
| **E 编辑器协同** | `pages/workflow/state.ts`（在骨架上完善，导出的接口只增不改）、`pages/workflow/collab/**` |
| **共享（只有汇总 agent 能改）** | `api/**`、`app.tsx`、`lib/router.tsx`、`styles/**`、`components/{layout,ui,takt,command-palette}.*`，以及挂载各 Tab 的 `pages/requirement/index.tsx`、`pages/run/node-drawer.tsx` |

没列出的已有文件（overview、attention、requirement 的其他 Tab、run 的其他文件）本轮不改。

## 约定的接口（占位组件已建好，props 不要改；要加 props 写变更请求）

| 文件 | 导出 | props | 挂载位置 |
|---|---|---|---|
| `pages/workflows-list.tsx` | `WorkflowsListPage` | 无 | 路由 `/workflows` |
| `pages/settings/workflows-tab.tsx` | `WorkflowsTab` | `{ space?: SpaceDetail }` | 设置页 `?tab=workflows` |
| `pages/settings/knowledge-tab.tsx` | `KnowledgeTab` | `{ space?: SpaceDetail }` | 设置页 `?tab=knowledge` |
| `pages/requirement/chat-tab.tsx` | `ChatTab` | `{ id: string; detail?: RequirementDetail }` | 需求页 `?tab=chat` |
| `pages/requirement/reviews-tab.tsx` | `ReviewsTab` | `{ id: string }` | 需求页 `?tab=reviews` |
| `pages/run/review/review-tab.tsx` | `ReviewTab` | `{ d: NodeDetail; runId: string; requirementId: string }` | 节点抽屉 `dtab=review`（仅 `kind=review`） |
| `pages/workflow/index.tsx` | `WorkflowEditorPage` | `{ id: string }` | 路由 `/workflows/:id` |
| `pages/workflow/canvas/workflow-canvas.tsx` | `WorkflowCanvas` | `{ wf: WorkflowDocState; selected?: string; onSelect(id?): void; highlight?: string[] }` | 编辑器中栏 |
| `pages/workflow/palette/node-palette.tsx` | `NodePalette` | `{ wf: WorkflowDocState }` | 编辑器左栏 |
| `pages/workflow/properties/properties-panel.tsx` | `PropertiesPanel` | `{ wf: WorkflowDocState; nodeId?: string }` | 编辑器右栏 |
| `pages/workflow/collab/save-status.tsx` | `SaveStatusBar` | `{ wf: WorkflowDocState }` | 编辑器顶栏 |
| `pages/workflow/collab/revisions-drawer.tsx` | `RevisionsDrawer` | `{ wf; workflowId: string; open: boolean; onClose(): void }` | 编辑器 |
| `pages/workflow/collab/conflict-dialog.tsx` | `ConflictDialog` | `{ wf }`（`wf.conflict` 为空时不渲染） | 编辑器 |
| `pages/workflow/collab/remote-change-banner.tsx` | `RemoteChangeBanner` | `{ wf; onShowDiff(rev: string): void }` | 编辑器 |
| `pages/workflow/collab/source-view.tsx` | `SourceView` | `{ wf }` | 编辑器"源码"视图 |
| `pages/workflow/collab/changed-nodes.ts` | `changedNodeIds(before, after)` | — | 画布高亮 |

D 和 E 只通过 `useWorkflowDocument(id)`（`pages/workflow/state.ts`）交互：画布改模型一律调 `wf.applyEdits(edits)`，拖动位置调 `wf.saveLayout(layout)`，不要直接调 DataSource 的写接口。

## 数据层（`api/`，共享）

- `source.ts`：`DataSource` 已含评审（`requirementReviews`）与 workflow 全部接口；409 统一抛 `WorkflowConflictError`（`.conflict` 为 `WorkflowConflict`）。
- `workflow-edit.ts`：`WorkflowEdit` 的纯函数实现（`applyWorkflowEdits`、`invertWorkflowEdits`、`findNode`、`allNodes`、`literalOf`、`lit`、`code`），mock 与编辑器共用。
- 演示数据：`mock-reviews.ts`（REQ-001 / REQ-003 的评审节点、轮次、打回边 `kind: 'route', label: '打回'`、review.* 事件）；`mock-workflows.ts` + `mock-workflow-seed.ts` + `mock-workflow-print.ts`（sdlc 可编辑、task 可编辑、hotfix 只读；修订历史 3 条；订阅 sdlc 约 9 秒后 Lead 修改一次）。
