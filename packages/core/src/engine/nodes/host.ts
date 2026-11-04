import type { Runtime } from '../runtime.js'

export type NodeHost = Pick<Runtime,
  'override' | 'deps' | 'state' | 'graph' | 'requests' | 'signal' | 'timestamp' | 'emit' | 'save' |
  'skipNode' | 'persistGraph' | 'removeChildren' | 'add' | 'addLoop' | 'context' | 'request' | 'shell' | 'model' | 'schedule' | 'containerState' | 'guard' | 'workspacePaths'
>
