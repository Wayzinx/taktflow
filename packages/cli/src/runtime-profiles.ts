import { loadRoleSources, profilesFromSources } from '@taktflow/core'

export async function loadRuntimeProfiles(dir: string, roles: Record<string, string>, warn?: (message: string) => void) {
  const profiles = profilesFromSources(await loadRoleSources(dir, roles, warn))
  for (const profile of Object.values(profiles)) profile.allowBash ??= false
  return profiles
}
