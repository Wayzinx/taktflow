import { currentSpaceId } from './space'

/** 打开运行成品里的一个网页：服务端登记集成工作树后跳到预览端口（docs/design/17）。 */
export function previewHref(runId: string, path: string): string {
  const space = currentSpaceId()
  const enc = encodeURIComponent
  return `/api${space ? `/s/${enc(space)}` : ''}/runs/${enc(runId)}/preview?path=${enc(path)}`
}
