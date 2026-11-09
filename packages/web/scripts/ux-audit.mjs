#!/usr/bin/env node
/**
 * 体验门禁（docs/design/22 §3.4、docs/dev/m4-web.md 体验基线 2）。
 *
 * 扫描 packages/web/src/pages/** 与 src/components/** 的 *.tsx / *.ts（不含测试），报告：
 *   loading-text   违规：用"加载中"或"…"表示加载状态（JSX 文本或字符串字面量里的"加载中"、单独的"…"、"正在读取…"这类）；
 *                  请用 <Skeleton> / <SkeletonRows> 等骨架原语。输入框 placeholder / aria-label / title 不算。
 *   cli-hint       警告：页面文案里出现 takt.config.json，或"运行 takt …"、`takt init` 这类 CLI 指引，且附近（上下 4 行）
 *                  没有对应的按钮（<button / stewardAsk / askSteward）；应该给按钮或"让管家帮我"，而不是教用户改文件、跑命令。
 *   async-empty    违规：文件里用 useAsync 取数据并直接渲染成列表（`x.data.map(` / `(x.data ?? []).map(`），却没有 <EmptyState>
 *                  （异步列表区域缺空状态）。辅助取数（下拉选项等不单独成区的）在 useAsync 那一行或上一行写 `ux-audit: ok <原因>` 豁免。
 *   identity-icon  违规：从 lucide 引 Bot / Sparkles 这类图标（docs/design/30 §1）。身份只有一套画法：人用 Avatar，
 *                  管家 / Lead / Agent 用 StewardMark / LeadMark / AgentMark，按钮里要"管家"图标用 BeeGlyph。
 *   adhoc-empty    违规：components/ui 以外的文件自己写 empty-state / empty-icon 类名拼空态；请用 <EmptyState> / <ErrorState>。
 *   raw-color      违规：CSS 里写有彩色的裸色值（#3b82f6、oklch(0.6 0.2 250)、rgb(59 130 246) 这类）；颜色只来自
 *                  styles/tokens.css 的变量。黑 / 白 / 中性灰（含透明度，做遮罩、阴影、高光用）不算；节拍蜂的画法（mascot/）除外。
 *
 * 豁免：在该行或上一行写注释 `ux-audit: ok <原因>`（CSS 用 /* ux-audit: ok <原因> *\/）。
 * 用法：node scripts/ux-audit.mjs [--json] [目录…]；有违规时退出码 1，只有警告时退出码 0。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dirs = args.filter((a) => !a.startsWith('--'))
const targets = (dirs.length ? dirs : ['src/pages', 'src/components', 'src/styles']).map((d) => resolve(ROOT, d))
const ALLOW = /ux-audit:\s*ok\b/

/** @type {Array<{file: string, line: number, rule: string, message: string, level: 'error' | 'warn', text: string}>} */
const findings = []

function walk(p, out = []) {
  const st = statSync(p)
  if (st.isFile()) {
    if ((/\.tsx?$/.test(p) && !/\.(test|d)\.tsx?$/.test(p)) || /\.css$/.test(p)) out.push(p)
    return out
  }
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    walk(join(p, name), out)
  }
  return out
}

/**
 * 极简词法：把源码拆成"代码"（注释与字符串换成空格，行号不变）和字符串字面量列表。
 * 代码部分里剩下的中文 / "…" 基本只可能是 JSX 文本。
 */
function lex(src) {
  const code = src.split('')
  const strings = []
  const allowLines = new Set()
  let i = 0
  let line = 1
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' '
  }
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '\n') {
      line++
      i++
    } else if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      const stop = end < 0 ? src.length : end
      if (ALLOW.test(src.slice(i, stop))) allowLines.add(line).add(line + 1)
      blank(i, stop)
      i = stop
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      const body = src.slice(i, stop)
      const endLine = line + (body.match(/\n/g)?.length ?? 0)
      if (ALLOW.test(body)) allowLines.add(endLine).add(endLine + 1)
      blank(i, stop)
      line = endLine
      i = stop
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const startLine = line
      const start = i
      let j = i + 1
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j++
        else if (src[j] === '\n') line++
        j++
      }
      // JSX 属性里的双引号字符串也走这里；记下它前面是不是 placeholder= 之类
      const before = src.slice(Math.max(0, start - 24), start)
      strings.push({ text: src.slice(start + 1, j), line: startLine, attr: /(placeholder|aria-label|title|alt)=\{?\s*$/.test(before) })
      blank(start, j + 1)
      i = j + 1
    } else i++
  }
  return { code: code.join(''), strings, allowLines }
}

const LOADING = [
  { re: /加载中/, what: '"加载中"' },
  { re: /^\s*(…|\.\.\.)\s*$/, what: '单独的"…"' },
  { re: /(正在|读取|载入|加载|获取|连接)[^\n<>{}'"`]{0,16}…/, what: '"正在…"式的加载文案' },
]
const CLI = [
  { re: /takt\.config\.json/, what: 'takt.config.json' },
  { re: /运行\s*`?\s*takt\b/, what: '"运行 takt …"' },
  { re: /\btakt\s+(init|req|run|serve|ws|kb|eval|space|workflow)\b/, what: 'takt CLI 命令' },
]

/** 附近（上下 4 行）有没有能替代 CLI 指引的按钮。 */
const ACTION = /<button\b|stewardAsk|askSteward|openSteward/
function hasActionNear(lines, line) {
  for (let k = Math.max(0, line - 5); k < Math.min(lines.length, line + 4); k++) if (ACTION.test(lines[k])) return true
  return false
}

/** 表示身份会造成"同一页几种画法"的 lucide 图标（docs/design/30 §1）。 */
const IDENTITY_ICONS = new Set(['Bot', 'BotMessageSquare', 'BotOff', 'Sparkle', 'Sparkles'])

/** CSS 裸色值是不是中性色（黑 / 白 / 灰，可带透明度）：遮罩、阴影、高光允许直接写。 */
function neutral(color) {
  const c = color.toLowerCase().replace(/\s+/g, ' ')
  if (/^#(0{3}|f{3}|0{6}|f{6})([0-9a-f]{2})?$/.test(c)) return true
  const ok = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)/.exec(c)
  if (ok) return Number(ok[2]) <= 0.02
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c)
  if (rgb) return rgb[1] === rgb[2] && rgb[2] === rgb[3]
  const hsl = /^hsla?\(\s*[\d.]+(deg)?[\s,]+([\d.]+)%/.exec(c)
  if (hsl) return Number(hsl[2]) <= 5
  return false
}

function checkCss(file, src) {
  const rel = relative(ROOT, file)
  if (/styles[\\/]tokens\.css$|[\\/]mascot[\\/]/.test(rel)) return
  const lines = src.split('\n')
  lines.forEach((text, idx) => {
    if (ALLOW.test(text) || (idx > 0 && ALLOW.test(lines[idx - 1]))) return
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|(?:oklch|rgba?|hsla?)\([^()]*\)/g)) {
      if (neutral(m[0])) continue
      findings.push({ file: rel, line: idx + 1, rule: 'raw-color', level: 'error', message: `裸色值 ${m[0]}：颜色只用 tokens.css 的变量（--c-*、--st-*、--accent…），确需新颜色先加 token`, text: text.trim().slice(0, 80) })
    }
  })
}

function check(file, src) {
  if (file.endsWith('.css')) return checkCss(file, src)
  const { code, strings, allowLines } = lex(src)
  const rel = relative(ROOT, file)
  const srcLines = src.split('\n')
  const push = (line, rule, level, message, text) => {
    if (allowLines.has(line)) return
    if (rule === 'cli-hint' && hasActionNear(srcLines, line)) return
    findings.push({ file: rel, line, rule, level, message, text: text.trim().slice(0, 80) })
  }
  // 身份图标：lucide 的 Bot / Sparkles 不再表示任何身份
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    const line = src.slice(0, m.index).split('\n').length
    for (const name of m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])) {
      if (IDENTITY_ICONS.has(name)) push(line, 'identity-icon', 'error', `引了 lucide 的 ${name}：人用 Avatar，管家 / Lead / Agent 用 StewardMark / LeadMark / AgentMark，按钮里的管家图标用 BeeGlyph`, m[0])
    }
  }
  // 自己拼的空态：空态只有 components/ui 里的 EmptyState / ErrorState 一种
  if (!/components[\\/]ui[\\/]/.test(rel)) {
    for (const st of strings) if (/(^|\s)empty-(state|icon)(\s|$)/.test(st.text)) push(st.line, 'adhoc-empty', 'error', '自己写了 empty-state / empty-icon 类名：请用 <EmptyState> / <ErrorState>', st.text)
  }
  // 异步列表区域的空状态：`const x = useAsync(...)` 且 `x.data.map(` / `(x.data ?? []).map(` 渲染成列表的，文件里至少要有一个 EmptyState
  if (!/<EmptyState\b/.test(code)) {
    code.split('\n').forEach((text, idx) => {
      const name = /\bconst\s+(\w+)\s*=\s*useAsync\b/.exec(text)?.[1]
      if (!name) return
      const listed = new RegExp(`\\b${name}\\.data\\??\\.map\\(|\\(${name}\\.data\\s*\\?\\?\\s*\\[\\]\\)\\.map\\(`).test(code)
      if (listed) push(idx + 1, 'async-empty', 'error', `${name} 由 useAsync 取来直接渲染成列表，却没有 <EmptyState>：补上空状态，或注明 ux-audit: ok 的原因`, text)
    })
  }
  // JSX 文本：代码部分逐行扫
  code.split('\n').forEach((text, idx) => {
    const line = idx + 1
    // 代码行里的中文段（JSX 文本）
    for (const seg of text.match(/>[^<>{}]*</g) ?? [text]) {
      for (const p of LOADING) if (p.re.test(seg.replace(/^>|<$/g, '')) && !/^\s*$/.test(seg)) push(line, 'loading-text', 'error', `用${p.what}表示加载状态，请用 <Skeleton> 系列`, seg)
      for (const p of CLI) if (p.re.test(seg)) push(line, 'cli-hint', 'warn', `文案里有 ${p.what}：给按钮或"让管家帮我"，不要教用户改文件 / 跑命令`, seg)
    }
  })
  for (const s of strings) {
    if (s.attr) continue
    for (const p of LOADING) if (p.re.test(s.text)) push(s.line, 'loading-text', 'error', `用${p.what}表示加载状态，请用 <Skeleton> 系列`, s.text)
    for (const p of CLI) if (p.re.test(s.text)) push(s.line, 'cli-hint', 'warn', `文案里有 ${p.what}：给按钮或"让管家帮我"，不要教用户改文件 / 跑命令`, s.text)
  }
}

const files = targets.flatMap((t) => walk(t))
for (const f of files) check(f, readFileSync(f, 'utf8'))

// 同一行同一规则只报一次
const seen = new Set()
const unique = findings.filter((f) => {
  const k = `${f.file}:${f.line}:${f.rule}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
const errors = unique.filter((f) => f.level === 'error')
const warns = unique.filter((f) => f.level === 'warn')

if (asJson) {
  console.log(JSON.stringify({ files: files.length, errors, warnings: warns }, null, 2))
} else {
  for (const f of [...errors, ...warns].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`${f.level === 'error' ? '✗' : '!'} ${f.file}:${f.line}  [${f.rule}] ${f.message}\n    ${f.text}`)
  }
  console.log(`\nux-audit：扫描 ${files.length} 个文件，${errors.length} 个违规，${warns.length} 个警告，${errors.length ? '未通过' : '通过'}`)
}
process.exit(errors.length ? 1 : 0)
