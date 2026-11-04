import type { HarnessInfo, ModelInfo, ProjectStores } from '@taktflow/core'

export type GetHarnesses = (stores: ProjectStores) => Promise<HarnessInfo[]>
export type GetModels = (stores: ProjectStores) => Promise<ModelInfo[]>
export type GetCatalog = (stores: ProjectStores) => Promise<{ harnesses: HarnessInfo[]; models: ModelInfo[] }>

export interface CatalogCallbacks {
  getHarnesses?: GetHarnesses
  getModels?: GetModels
  getCatalog?: GetCatalog
}
