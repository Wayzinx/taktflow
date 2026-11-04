import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'loop') throw new Error('内部错误：不是 loop')
  const ns = host.state.nodes[node.id]!
  if (ns.iteration === undefined) {
    ns.iteration = 1
    host.addLoop(entry, 1)
    await host.persistGraph()
    await host.save()
  }
  for (;;) {
    const ids = node.body.map((child) => `${node.id}/${child.id}`)
    await host.schedule(ids)
    host.containerState(ns, ids)
    if (ns.status === 'waiting_human') { await host.save(); return }
    if (await node.until(host.context(entry, true))) return
    if (ns.iteration! >= node.maxIterations) {
      if ((node.onExhausted ?? 'human') === 'human') await host.request(entry, `循环 ${node.title} 已达到 ${node.maxIterations} 轮，是否放行？`, 'approve')
      else throw new Error(`循环达到 maxIterations=${node.maxIterations}`)
      return
    }
    host.removeChildren(node.id)
    ns.iteration!++
    host.addLoop(entry, ns.iteration!)
    await host.persistGraph()
    await host.save()
  }

}
