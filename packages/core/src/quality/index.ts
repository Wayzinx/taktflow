import type { ProjectStores } from '../interfaces.js'
import type { Actor } from '../types.js'
import { createQualityStore } from './store.js'

export { createQualityStore, FsQualityStore, QualityConflictError } from './store.js'
export type { QualityInput } from './migration.js'

const quality = (stores: ProjectStores) => stores.quality ?? createQualityStore(stores)
export const syncQuality = (stores: ProjectStores, runId?: string) => quality(stores).sync(runId)
export const qualityStatus = (stores: ProjectStores) => quality(stores).status()
export const verifyQuality = (stores: ProjectStores) => quality(stores).status()
export const repairQuality = (stores: ProjectStores, by: Actor, reason: string) => quality(stores).repair(by, reason)
