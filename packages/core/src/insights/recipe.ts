import type { ProjectStores } from '../interfaces.js'
import type { AssetRef, Recipe } from '../quality.js'
import { canonicalJson } from '../util/hash.js'
import { eventsOf } from './quality-data.js'

export async function recipe(stores: ProjectStores, invocationId: string): Promise<Recipe | undefined> {
  const runId = invocationId.slice(0, invocationId.lastIndexOf(':'))
  if (!runId) return undefined
  const events = await stores.events.read(runId, { types: ['invocation.started'] })
  return eventsOf(events, 'invocation.started').find((event) => event.data.invocation.invocationId === invocationId)?.data.recipe
}

export interface RecipeFieldDiff {
  field: keyof Recipe
  before: Recipe[keyof Recipe] | null
  after: Recipe[keyof Recipe] | null
}

const asset = (ref: AssetRef): AssetRef => ({ kind: ref.kind, id: ref.id, sha256: ref.sha256, ...(ref.revision === undefined ? {} : { revision: ref.revision }) })

export function recipeDiff(a: Recipe, b: Recipe): RecipeFieldDiff[] {
  const normalize = (value: Recipe): Recipe => ({ ...value, profile: asset(value.profile), template: asset(value.template), skills: value.skills.map(asset) })
  const before = normalize(a), after = normalize(b)
  const fields: Array<keyof Recipe> = ['recipeId', 'role', 'profile', 'skills', 'template', 'harness', 'provider', 'model', 'effort', 'outputSchema']
  return fields.filter((field) => canonicalJson(before[field] ?? null) !== canonicalJson(after[field] ?? null))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }))
}
