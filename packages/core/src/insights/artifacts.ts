import type { WorkspaceStore } from '../interfaces.js'
import type { ArtifactRecord, RequirementMetrics } from '../types.js'

export interface CaseRecord {
  id: string
  title?: string
  covers: string[]
  path: string
}

export interface ArtifactData {
  artifacts: ArtifactRecord[]
  cases: CaseRecord[]
  acs: Map<string, string>
  results: Map<string, string>
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(store: WorkspaceStore, requirementId: string, path: string): Promise<unknown> {
  const content = await store.readArtifact({ workspace: requirementId, path })
  if (!content) return undefined
  try {
    return JSON.parse(content.toString('utf8')) as unknown
  } catch (cause) {
    throw new Error(`无法解析产物 ${requirementId}/${path}`, { cause })
  }
}

export async function readArtifactData(store: WorkspaceStore, requirementId: string): Promise<ArtifactData> {
  const artifacts = await store.listArtifacts(requirementId)
  const acs = new Map<string, string>()
  const defined = new Set<string>()
  const specPaths = new Set(['spec/spec.md', ...artifacts.filter((artifact) => artifact.kind === 'spec').map((artifact) => artifact.path)])
  const specs = await Promise.all([...specPaths].map(async (path) => {
    const content = await store.readArtifact({ workspace: requirementId, path })
    if (!content && artifacts.some((artifact) => artifact.path === path)) throw new Error(`清单中的 spec 产物内容缺失：${requirementId}/${path}`)
    return content?.toString('utf8')
  }))
  for (const spec of specs) {
    if (spec === undefined) continue
    for (const line of spec.split(/\r?\n/)) {
      for (const match of line.matchAll(/\bAC-\d+(?:-\d+)?\b/g)) {
        const ac = match[0]
        const definition = /^[\s#*+\-\d.)|`]*$/.test(line.slice(0, match.index))
        const remainder = line.slice(match.index + ac.length)
        const title = (/^\s*\|/.test(line) && definition ? remainder.replace(/^[\s*`]*\|/, '').split('|')[0]! : remainder)
          .replace(/^[\s:：|*`\]—–-]+/, '').replace(/[\s|*`]+$/, '')
        if (definition && !defined.has(ac)) { acs.set(ac, title || ac); defined.add(ac) }
        else if (!acs.has(ac) || (!defined.has(ac) && acs.get(ac) === ac)) acs.set(ac, title || ac)
      }
    }
  }
  const cases: CaseRecord[] = []
  const ids = new Set<string>()
  const caseFiles = artifacts.filter((artifact) => /^cases\/.*\.json$/.test(artifact.path))
  const contents = await Promise.all(caseFiles.map((artifact) => readJson(store, requirementId, artifact.path)))
  for (const [index, content] of contents.entries()) {
    const path = caseFiles[index]!.path
    if (content === undefined) throw new Error(`清单中的用例产物内容缺失：${requirementId}/${path}`)
    if (!isObject(content) || typeof content.id !== 'string' || !content.id.trim()
      || (content.covers !== undefined && (!Array.isArray(content.covers) || !content.covers.every((ac) => typeof ac === 'string')))) {
      throw new Error(`用例产物 ${requirementId}/${path} 必须包含 id 和字符串数组 covers（可省略）`)
    }
    if (ids.has(content.id)) throw new Error(`用例 ID 重复：${requirementId}/${path}: ${content.id}`)
    ids.add(content.id)
    cases.push({ id: content.id, title: typeof content.title === 'string' ? content.title : undefined, covers: [...new Set((content.covers ?? []) as string[])], path })
  }
  const summary = await readJson(store, requirementId, 'evidence/summary.json')
  const results = new Map<string, string>()
  if (summary !== undefined) {
    if (!isObject(summary) || !Array.isArray(summary.cases)) throw new Error(`产物 ${requirementId}/evidence/summary.json 必须包含 cases 数组`)
    for (const result of summary.cases) {
      if (!isObject(result) || typeof result.id !== 'string' || typeof result.status !== 'string') {
        throw new Error(`产物 ${requirementId}/evidence/summary.json 的用例结果必须包含 id/status`)
      }
      if (results.has(result.id)) throw new Error(`产物 ${requirementId}/evidence/summary.json 的用例结果重复：${result.id}`)
      results.set(result.id, result.status)
    }
  }
  return { artifacts, cases, acs, results }
}

export function acCoverage(data: ArtifactData): NonNullable<RequirementMetrics['acCoverage']> {
  return [...data.acs].map(([ac, title]) => {
    const related = data.cases.filter((testCase) => testCase.covers.includes(ac))
    const passed = related.filter((testCase) => data.results.get(testCase.id) === 'passed').length
    const failed = related.filter((testCase) => ['failed', 'error'].includes(data.results.get(testCase.id) ?? '')).length
    return { ac, title, cases: related.length, passed, failed, status: related.length === 0 ? 'uncovered' : passed === related.length ? 'covered' : 'partial' }
  })
}
