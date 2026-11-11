import { describe, expect, it } from 'vitest'
import type { ArtifactKind, ArtifactRecord } from '@taktflow/core'
import { keyArtifacts } from './key-artifacts'

const human = { type: 'human' as const, id: 'u' }
function art(path: string, kind: ArtifactKind, versions: Array<[runId: string | undefined, at: string]>, mediaType = path.endsWith('.json') ? 'application/json' : 'text/markdown'): ArtifactRecord {
  return {
    path, kind, mediaType, tags: [], traceIds: [],
    versions: versions.map(([runId, at], index) => ({
      version: index + 1, sha256: 'x', size: 1, createdAt: at, author: human, derivedFrom: [],
      ...(runId ? { producedBy: { runId, nodeId: 'n' } } : {}),
    })),
  }
}

describe('keyArtifacts', () => {
  // 真实需求的形状：多轮运行留下旧轮次 PRD / 改动说明，大量自测证据和评审轮次 JSON
  const records = [
    art('inputs/request.md', 'input', [[undefined, '2026-11-09T07:00:00Z']]),
    art('spec/prd.md', 'spec', [['run-1', '2026-11-09T10:00:00Z']]),
    art('reviews/review-prd/summary.md', 'review', [['run-1', '2026-11-09T10:30:00Z']]),
    art('spec/round-prd.md', 'spec', [['run-2', '2026-11-11T04:00:00Z']]),
    art('tasks/round-change.md', 'task', [['run-2', '2026-11-11T04:30:00Z']]),
    art('tasks/implement.diff', 'code-change', [['run-1', '2026-11-09T11:00:00Z'], ['run-2', '2026-11-11T04:38:00Z']], 'application/octet-stream'),
    art('tasks/selftest-implement-1-a.json', 'evidence', [['run-2', '2026-11-11T04:20:00Z']]),
    art('reviews/review-code/r1-round-1.json', 'review', [['run-2', '2026-11-11T04:38:00Z']]),
    art('reviews/review-code/summary.md', 'review', [['run-2', '2026-11-11T04:40:00Z']]),
    art('decisions/auto-answers/run-2_acceptance-1.md', 'decision', [['run-2', '2026-11-11T04:40:30Z']]),
    art('decisions/auto-answers/run-1_answer-clarify-1.md', 'decision', [['run-1', '2026-11-09T08:00:00Z']]),
    art('decisions/lead-notes.md', 'decision', [[undefined, '2026-11-11T05:00:00Z']]),
    art('design/contracts.json', 'contract', [['run-2', '2026-11-11T04:10:00Z']]),
  ]

  it('只取最近一轮运行的结论 / 交付物；旧轮次、自测证据、评审轮次 JSON、Lead 笔记都不算', () => {
    const key = keyArtifacts(records)
    expect(key.runId).toBe('run-2')
    expect([...key.paths].sort()).toEqual([
      'decisions/auto-answers/run-2_acceptance-1.md',
      'reviews/review-code/summary.md',
      'spec/round-prd.md',
      'tasks/implement.diff',
      'tasks/round-change.md',
    ])
  })

  it('人改过的最新版本仍算这一轮的产物', () => {
    const edited = records.map((r) => (r.path === 'spec/round-prd.md' ? { ...r, versions: [...r.versions, { ...r.versions[0]!, version: 2, createdAt: '2026-11-11T06:00:00Z', producedBy: undefined }] } : r))
    expect(keyArtifacts(edited).paths.has('spec/round-prd.md')).toBe(true)
  })

  it('还没有运行产出时，人放进来的需求说明 / 方案算重点；原始输入不算', () => {
    const key = keyArtifacts([art('inputs/request.md', 'input', [[undefined, 't']]), art('spec/prd.md', 'spec', [[undefined, 't']]), art('design/design.md', 'design', [[undefined, 't']])])
    expect(key.runId).toBeUndefined()
    expect([...key.paths].sort()).toEqual(['design/design.md', 'spec/prd.md'])
  })
})
