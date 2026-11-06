import type { ProjectStores } from '../interfaces.js'
import type { Actor, RouteDecision } from '../types.js'
import { routeRequirement, type RouteInput } from './index.js'

export interface RoutedInput { requirementId: string; workflowId: string; args?: Record<string, unknown>; route?: RouteDecision }
export async function startRouted(stores: ProjectStores, workflows: RouteInput['workflows'], input: RoutedInput, by: Actor,
  decide?: () => Promise<RouteDecision>, replyTo?: string): Promise<RoutedInput> {
  const route = input.workflowId === 'auto' ? await (decide?.() ?? routeRequirement({ stores, workflows, requirementId: input.requirementId, by })) : input.route
  if (input.workflowId === 'auto' && route) await stores.chat.post(input.requirementId, {
    author: by, kind: 'route', route, replyTo, text: `${route.tier} · ${route.workflowId}：${route.reason}`,
  })
  return { ...input, workflowId: route?.workflowId ?? input.workflowId, route, args: { ...input.args, ...(route ? { tier: route.tier } : {}) } }
}
