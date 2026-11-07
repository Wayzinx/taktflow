import type { KnowledgeStore, Actor } from '@taktflow/core'
export interface EvalDeps { store: KnowledgeStore; chat?: (prompt: string) => Promise<string> }
export async function synthesizeCases(_deps: EvalDeps, ..._args: Parameters<KnowledgeStore['synthesizeCases']>): ReturnType<KnowledgeStore['synthesizeCases']> { throw new Error('未实现（m4-kb-eval）') }
export async function harvestCases(_deps: EvalDeps, ..._args: Parameters<KnowledgeStore['harvestCases']>): ReturnType<KnowledgeStore['harvestCases']> { throw new Error('未实现（m4-kb-eval）') }
export async function runEval(_deps: EvalDeps, ..._args: Parameters<KnowledgeStore['runEval']>): ReturnType<KnowledgeStore['runEval']> { throw new Error('未实现（m4-kb-eval）') }
export async function publishGate(deps: EvalDeps, id: string, _input: { version?: number; by: Actor; reason: string; force?: boolean }): Promise<{ pass: boolean; reasons: string[] }> {
  const active = (await deps.store.evalSets(id)).flatMap(s => s.cases).some(c => c.status === 'active')
  return { pass: true, reasons: [active ? '评测门槛尚未接入' : '无评测用例，首次发布'] }
}
