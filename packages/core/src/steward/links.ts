const e = encodeURIComponent
export const stewardLinks = {
  home: '/solo',
  spaces: '/spaces',
  overview: (space: string) => `/s/${e(space)}`,
  requirements: (space: string) => `/s/${e(space)}/requirements`,
  requirement: (space: string, id: string, tab?: string) =>
    `/s/${e(space)}/req/${e(id)}${tab ? `?tab=${e(tab)}` : ''}`,
  run: (space: string, id: string, node?: string) =>
    `/s/${e(space)}/run/${e(id)}${node ? `?node=${e(node)}` : ''}`,
  workflow: (space: string, id: string) => `/s/${e(space)}/workflows/${e(id)}`,
  knowledge: (space: string, id: string) => `/s/${e(space)}/knowledge/${e(id)}`,
  /** 需求公共存放区里的一个产物（path 相对需求目录）。 */
  artifact: (space: string, id: string, path: string) => `/s/${e(space)}/req/${e(id)}?tab=artifacts&path=${e(path)}`,
  /** 运行成品里的一个网页：服务端跳到预览端口（docs/design/17）。 */
  preview: (space: string, runId: string, path: string) => `/api/s/${e(space)}/runs/${e(runId)}/preview?path=${e(path)}`,
  settings: (space: string, tab: string) => `/s/${e(space)}/settings?tab=${e(tab)}`,
  attention: (space: string) => `/s/${e(space)}/attention`,
}
