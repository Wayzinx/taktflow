import type { CSSProperties } from 'react'
import { Bee } from '../mascot'
import './brand-icon.css'

// 品牌标识：每个 harness、每家 LLM API 用自己的图标（docs/design/32 §5）。SVG 来自 @lobehub/icons-static-svg（MIT），见 NOTICE.md。
const svgs = import.meta.glob('./svg/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const ICONS: Record<string, string> = Object.fromEntries(Object.entries(svgs).map(([path, svg]) => [path.slice('./svg/'.length, -'.svg'.length), svg]))

/** harness id、ACP 预设 id → 图标键。server 给了 icon 时以 server 为准。 */
const HARNESS: Record<string, string> = {
  'claude-code': 'claudecode', claude: 'claudecode', codex: 'codex', trae: 'trae', pi: 'pi', dsh: 'deepseek',
  'gemini-cli': 'geminicli', gemini: 'geminicli', 'cursor-agent': 'cursor', cursor: 'cursor', 'qwen-code': 'qwen', qwen: 'qwen',
  'kimi-cli': 'kimi', kimi: 'kimi', opencode: 'opencode', goose: 'goose', copilot: 'githubcopilot', hermes: 'hermesagent',
  openclaw: 'openclaw', amp: 'amp', cline: 'cline', kilo: 'kilocode', codebuddy: 'codebuddy', kiro: 'kiro', qoder: 'qoder',
}

/** provider id / 预设 id → 图标键；对不上再按 baseURL 主机名猜。 */
const PROVIDER: Record<string, string> = {
  openai: 'openai', 'azure-openai': 'azure', anthropic: 'anthropic', deepseek: 'deepseek', moonshot: 'moonshot', kimi: 'kimi',
  zhipu: 'zhipu', dashscope: 'bailian', qwen: 'qwen', ark: 'volcengine', 'ark-coding': 'volcengine', minimax: 'minimax',
  'minimax-cn': 'minimax', siliconflow: 'siliconcloud', openrouter: 'openrouter', ollama: 'ollama', vllm: 'vllm', lmstudio: 'lmstudio',
  gemini: 'gemini', google: 'gemini',
}
const HOSTS: Array<[RegExp, string]> = [
  [/deepseek\.com/, 'deepseek'], [/openai\.com/, 'openai'], [/anthropic\.com/, 'anthropic'], [/moonshot\.(cn|ai)/, 'moonshot'],
  [/bigmodel\.cn|z\.ai/, 'zhipu'], [/dashscope|aliyuncs/, 'bailian'], [/volces\.com|volcengine/, 'volcengine'], [/minimaxi?\./, 'minimax'],
  [/siliconflow/, 'siliconcloud'], [/openrouter\.ai/, 'openrouter'], [/azure/, 'azure'], [/googleapis|generativelanguage/, 'gemini'],
  [/localhost:11434|ollama/, 'ollama'], [/localhost:1234/, 'lmstudio'],
]

export function harnessIconKey(h: { id: string; icon?: string; preset?: string }): string | undefined {
  if (h.icon === 'takt' || h.id === 'native') return 'takt'
  return [h.icon, h.preset && HARNESS[h.preset], HARNESS[h.id], HARNESS[h.id.replace(/-(acp|cli)$/, '')]].find((k): k is string => Boolean(k && ICONS[k]))
}

export function providerIconKey(p: { id: string; preset?: string; baseURL?: string }): string | undefined {
  const byHost = p.baseURL ? HOSTS.find(([re]) => re.test(p.baseURL!))?.[1] : undefined
  return [p.preset && PROVIDER[p.preset], PROVIDER[p.id], byHost].find((k): k is string => Boolean(k && ICONS[k]))
}

/** 有图标画图标，没有就画名字首字母；size 是边长（px）。 */
export function BrandIcon({ k, label, size = 16, className, style }: { k?: string; label: string; size?: number; className?: string; style?: CSSProperties }) {
  const svg = k ? ICONS[k] : undefined
  const css = { '--brand-size': `${size}px`, ...style } as CSSProperties
  // taktflow 自己（直连 API 的内置 harness）用应用标识
  if (k === 'takt') return <span className={['brand-icon', className].filter(Boolean).join(' ')} style={css} aria-hidden><Bee size={size} logo still label="taktflow" /></span>
  if (!svg) {
    return (
      <span className={['brand-icon', 'is-fallback', className].filter(Boolean).join(' ')} style={css} aria-hidden>
        {label.trim().slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return <span className={['brand-icon', className].filter(Boolean).join(' ')} style={css} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
}
