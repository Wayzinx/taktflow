import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { HarnessAdapter, HarnessEvent, HarnessResult, Usage } from '@taktflow/core'
import { collectSecrets, createRedactor, finalizeResult } from './process.js'

export interface MockStep {
  match?: { role?: string; nodeId?: string; promptIncludes?: string }
  writes?: Record<string, string>
  finalText?: string
  structured?: unknown
  usage?: Usage
  toolCalls?: Array<{ tool: string; input: string; output?: string }>
  compaction?: { beforeTokens: number; afterTokens: number; summary: string; dropped: string[] }
  fail?: string
  times?: number
}

export interface MockScript {
  steps: MockStep[]
}

export function createMockHarness(script: MockScript): HarnessAdapter {
  const consumed = script.steps.map(() => 0)
  return {
    id: 'mock',
    displayName: 'Mock',
    capabilities: {
      toolPhases: false, readOnly: false, modelOverride: false, effortOverride: false,
      resume: false, structuredOutput: false, toolEvents: true, usage: true, cost: true,
      compactionEvents: true, customProvider: false, sandbox: false, mcp: false,
    },
    async available() { return { ok: true } },
    async run(req, onEvent) {
      if (req.provider) {
        return finalizeResult(req, { ok: false, finalText: '', error: 'Mock does not support custom providers' }, { ok: true, stdout: '', stderr: '' })
      }
      const redact = createRedactor(collectSecrets(req))
      const emit = (event: HarnessEvent) => onEvent(JSON.parse(redact(JSON.stringify(event))) as HarnessEvent)
      let result: HarnessResult = { ok: true, finalText: '' }
      try {
        const checkCancelled = () => {
          if (req.signal?.aborted) throw new Error('Mock cancelled')
        }
        checkCancelled()
        const index = script.steps.findIndex((step, i) => {
          const match = step.match
          return consumed[i]! < (step.times ?? Infinity)
            && (match?.role === undefined || match.role === req.env?.TAKT_ROLE)
            && (match?.nodeId === undefined || match.nodeId === req.env?.TAKT_NODE)
            && (match?.promptIncludes === undefined || req.prompt.includes(match.promptIncludes))
        })
        // 在首次 await（包括写文件）之前占用次数，保证同实例并发调用的顺序。
        if (index !== -1) consumed[index]!++
        const step = script.steps[index]
        result = {
          ok: step?.fail === undefined,
          finalText: step ? step.finalText ?? '' : '(mock) no step matched',
          error: step?.fail,
          usage: step?.usage,
        }
        if (step?.structured !== undefined) {
          result.finalText += `\n\`\`\`json\n${JSON.stringify(step.structured)}\n\`\`\``
        }
        emit({ type: 'started', sessionId: req.sessionId, model: req.model })
        for (const [path, content] of Object.entries(step?.writes ?? {})) {
          checkCancelled()
          if (path.includes('{{workspace}}') && !req.env?.TAKT_WORKSPACE) {
            throw new Error('Mock write requires TAKT_WORKSPACE')
          }
          const target = resolve(req.cwd, path.replaceAll('{{workspace}}', req.env?.TAKT_WORKSPACE ?? ''))
          await mkdir(dirname(target), { recursive: true })
          checkCancelled()
          await writeFile(target, content, 'utf8')
        }
        checkCancelled()
        for (const call of step?.toolCalls ?? []) emit({ type: 'tool_call', ...call })
        if (step?.usage) emit({ type: 'usage', usage: step.usage })
        if (step?.compaction) {
          emit({ type: 'compacted', record: { ...step.compaction, at: new Date().toISOString(), trigger: 'auto' } })
        }
        emit({ type: 'message', role: 'assistant', text: result.finalText })
      } catch (error) {
        result.ok = false
        result.error = [result.error, `Mock failed: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('\n')
      }
      return finalizeResult(req, result, { ok: true, stdout: '', stderr: '' })
    },
  }
}

export async function loadMockScript(path: string): Promise<MockScript> {
  return JSON.parse(await readFile(path, 'utf8')) as MockScript
}
