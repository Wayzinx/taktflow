import { ApiRequestError } from './client'
import { RoleConflictError, type M8Source } from './source-m8'

interface Http {
  req: <T>(method: string, path: string, body?: unknown) => Promise<T>
  get: <T>(path: string) => Promise<T>
}

const enc = encodeURIComponent

/** M8 接口的 HTTP 实现（docs/design/30 §3、§4）。 */
export function createM8Http({ req, get }: Http): M8Source {
  return {
    agentRoles: () => get('/space/agents'),
    agentRole: (role) => get(`/space/agents/${enc(role)}`),
    saveAgentRole: (role, write) =>
      req<Awaited<ReturnType<M8Source['saveAgentRole']>>>('PUT', `/space/agents/${enc(role)}`, write).catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.status === 409) throw new RoleConflictError(e.message)
        throw e
      }),
    deleteAgentRole: (role, reason) => req<void>('DELETE', `/space/agents/${enc(role)}`, { reason }),
    automations: () => get('/space/automations'),
    saveAutomation: (automation, reason) => req('PUT', `/space/automations/${enc(automation.id)}`, { automation, reason }),
    deleteAutomation: (id, reason) => req<void>('DELETE', `/space/automations/${enc(id)}`, { reason }),
    triggerAutomation: (id, reason) => req('POST', `/space/automations/${enc(id)}/trigger`, { reason }),
    automationRuns: (id) => get(`/space/automations/${enc(id)}/runs`),
    retryAutomationRun: (id, recordId, reason) => req('POST', `/space/automations/${enc(id)}/runs/${enc(recordId)}/retry`, { reason }),
    saveChannel: (channel, reason) => req('PUT', `/space/channels/${enc(channel.id)}`, { channel, reason }),
    deleteChannel: (id, reason) => req<void>('DELETE', `/space/channels/${enc(id)}`, { reason }),
    testChannel: (id, reason) => req('POST', `/space/channels/${enc(id)}/test`, { reason }),
    skillTree: (name) => get(`/space/skills/${enc(name)}/files`),
    skillFile: (name, path) => get(`/space/skills/${enc(name)}/file?path=${enc(path)}`),
    saveSkillFile: (name, path, body) => req('PUT', `/space/skills/${enc(name)}/file?path=${enc(path)}`, body),
    deleteSkillFile: (name, path, reason) => req<void>('DELETE', `/space/skills/${enc(name)}/file?path=${enc(path)}`, { reason }),
    deleteSkill: (name, reason) => req<void>('DELETE', `/space/skills/${enc(name)}`, { reason }),
    previewSkillImport: (source) => req('POST', '/space/skills/import/preview', { source }),
    importSkills: (request) => req('POST', '/space/skills/import', request),
  }
}
