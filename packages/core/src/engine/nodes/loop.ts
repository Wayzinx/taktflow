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
    const children = Object.values(host.state.nodes).filter((child) => child.id.startsWith(`${node.id}/`))
    let suppressed = children.some((child) => child.status === 'blocked' && child.failures?.some((failure) => failure.code !== 'judge:flaky' && failure.count >= (host.deps.stores.config.retry?.maxSameFailure ?? 2)))
    const failed = children.some((child) => child.status === 'failed' || child.status === 'blocked')
    if (failed && !suppressed) {
      host.containerState(ns, ids)
      return
    }
    if (!suppressed && !failed) {
      host.containerState(ns, ids)
      if (ns.status === 'waiting_human') { await host.save(); return }
      if (await node.until(host.context(entry, true))) return
      // 有判决时按判决类别计数；没有判决的执行失败用 subject 计数，避免给 flaky 再加一层限制。
      const judged = children.some((child) => child.result && typeof child.result === 'object' && 'verdicts' in child.result)
      if (!judged) for (const child of children) {
        const result = child.result as { failures?: Array<{ subject: string }> } | undefined
        if (!Array.isArray(result?.failures)) continue
        for (const failure of result.failures) {
          if (await host.noteFailure(entry, 'error', `${child.id}:${failure.subject}`, `循环执行仍有失败：${failure.subject}`, child)) suppressed = true
        }
      }
    }
    if (suppressed || ns.iteration! >= node.maxIterations) {
      if ((node.onExhausted ?? 'human') === 'human') await host.request(entry, suppressed ? `循环 ${node.title} 同样的失败重复出现，已提前停止，是否放行？` : `循环 ${node.title} 已达到 ${node.maxIterations} 轮，是否放行？`, 'approve')
      else throw new Error(suppressed ? '循环同样的失败重复出现，已提前停止' : `循环达到 maxIterations=${node.maxIterations}`)
      return
    }
    host.removeChildren(node.id)
    ns.iteration!++
    host.addLoop(entry, ns.iteration!)
    await host.persistGraph()
    await host.save()
  }

}
