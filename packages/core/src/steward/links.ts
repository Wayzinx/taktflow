const e = encodeURIComponent
export const stewardLinks = {
  home: '/steward',
  spaces: '/spaces',
  overview: (space: string) => `/s/${e(space)}`,
  requirement: (space: string, id: string, tab?: string) =>
    `/s/${e(space)}/req/${e(id)}${tab ? `?tab=${e(tab)}` : ''}`,
  run: (space: string, id: string, node?: string) =>
    `/s/${e(space)}/run/${e(id)}${node ? `?node=${e(node)}` : ''}`,
  workflow: (space: string, id: string) => `/s/${e(space)}/workflows/${e(id)}`,
  knowledge: (space: string, id: string) => `/s/${e(space)}/knowledge/${e(id)}`,
  settings: (space: string, tab: string) => `/s/${e(space)}/settings?tab=${e(tab)}`,
  attention: (space: string) => `/s/${e(space)}/attention`,
}
