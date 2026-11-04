import { expect, it } from 'vitest'
import type { ArtifactRecord } from '../types.js'
import { buildTraceGraph } from './trace.js'
it('判决连接被判用例，任务和代码连接实现的 AC，仅给当前版本添加内容关系', () => {
  const artifacts: ArtifactRecord[] = [
    { path: 'verdict.json', kind: 'verdict', traceIds: ['TC-ONE'] },
    { path: 'task.md', kind: 'task', traceIds: ['AC-001'] },
    { path: 'code.md', kind: 'code-change', traceIds: ['AC-001'] },
  ].map((item) => ({ ...item, mediaType: 'text/plain', tags: [], versions: [1, 2].map((version) => ({ version, sha256: '', size: 0, createdAt: '', author: { type: 'system', id: 's' }, derivedFrom: [] })) })) as ArtifactRecord[]
  const graph = buildTraceGraph('REQ-1', 'Test', { artifacts, cases: [], acs: new Map([['AC-001', 'AC']]), results: new Map() })
  expect(graph.edges.filter((edge) => edge.rel === 'judged')).toEqual([{ from: 'artifact:REQ-1:verdict.json@2', to: 'TC-ONE', rel: 'judged' }])
  expect(graph.edges.filter((edge) => edge.rel === 'implements')).toEqual([
    { from: 'artifact:REQ-1:task.md@2', to: 'AC-001', rel: 'implements' },
    { from: 'artifact:REQ-1:code.md@2', to: 'AC-001', rel: 'implements' },
  ])
})
