import { describe, expect, it } from 'vitest'
import { revisionAuthor } from './revision-who'

const person = (id: string) => (id === 'demo-owner' ? '你' : id)

describe('revisionAuthor', () => {
  it('管家提案：管家起草、批准人批准，原因去掉提案编号和会话链接', () => {
    expect(revisionAuthor({ author: { type: 'human', id: 'demo-owner' }, reason: '管家提案 5113d6fe-8dfe：统一用 Codex /solo?thread=2b4e6b09-94be' }, person)).toMatchObject({
      kind: 'steward', name: '管家', note: '你批准', reason: '统一用 Codex', thread: '2b4e6b09-94be',
    })
  })
  it('撤销提案算撤销的人；直接改的算本人', () => {
    expect(revisionAuthor({ author: { type: 'human', id: 'zhang' }, reason: '撤销管家提案 7333900c：改错了' }, person)).toMatchObject({ kind: 'human', name: 'zhang', reason: '撤销管家提案：改错了' })
    expect(revisionAuthor({ author: { type: 'human', id: 'demo-owner' }, reason: '修改 clarify.harness' }, person)).toMatchObject({ kind: 'human', name: '你', reason: '修改 clarify.harness' })
  })
  it('绕过平台改文件的是外部修改；agent 和系统按 author', () => {
    expect(revisionAuthor({ author: { type: 'agent', role: 'unknown', harness: 'external' }, reason: '外部修改' }, person)).toMatchObject({ kind: 'external', name: '外部修改' })
    expect(revisionAuthor({ author: { type: 'agent', role: 'lead', harness: 'codex' } }, person)).toMatchObject({ kind: 'agent', name: 'Lead' })
    expect(revisionAuthor({ author: { type: 'system', id: 'workflow-source' } }, person)).toMatchObject({ kind: 'system', name: 'workflow-source' })
  })
})
