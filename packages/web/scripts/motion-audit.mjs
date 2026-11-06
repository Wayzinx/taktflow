#!/usr/bin/env node
/**
 * 动效规范检查（docs/dev/m3-web.md「动效规范」、DESIGN.md「Motion」）。
 *
 * 扫描 packages/web/src 下的 *.css / *.tsx / *.ts，报告：
 *   transition-all     `transition: all` / `transition-property: all`
 *   scale-zero         `scale(0)`（含 scale(0, …) / scale3d(0, …)）
 *   size-transition    对 width / height（含 min- / max-）做 transition，进度条请用 transform: scaleX()
 *   infinite-no-reduce 无限动画所在规则在同一文件的 `@media (prefers-reduced-motion: reduce)` 里没有兜底
 *   dup-keyframes      同名 @keyframes 定义在不止一处
 *   scale-too-small    （警告，不影响退出码）缩放小于 0.985
 *
 * 豁免：在违规行或上一行写注释 `motion-audit: ok <原因>`。
 * 用法：node scripts/motion-audit.mjs [--json] [目录…]；有违规时退出码 1。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dirs = args.filter((a) => !a.startsWith('--'))
const targets = (dirs.length ? dirs : ['src']).map((d) => resolve(ROOT, d))

const SIZE_PROPS = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'inline-size', 'block-size'])
const MIN_SCALE = 0.985
const ALLOW = /motion-audit:\s*ok\b/

/** @type {Array<{file: string, line: number, rule: string, message: string, level: 'error' | 'warn'}>} */
const findings = []
/** keyframe 名 → 定义位置 */
const keyframes = new Map()

function walk(p, out = []) {
  const st = statSync(p)
  if (st.isFile()) {
    if (/\.(css|tsx?)$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p)
    return out
  }
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    walk(join(p, name), out)
  }
  return out
}

/** 去掉注释但保留换行，行号不变；同时记下带豁免标记的行。 */
function stripComments(src, allowLines) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, offset) => {
    if (ALLOW.test(m)) {
      const start = src.slice(0, offset).split('\n').length
      const end = start + m.split('\n').length - 1
      allowLines.add(end).add(end + 1)
    }
    return m.replace(/[^\n]/g, ' ')
  })
}

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length

function report(ctx, idx, rule, message, level = 'error') {
  const line = typeof idx === 'number' && idx >= 0 && ctx.src ? lineAt(ctx.src, idx) : idx
  if (ctx.allow.has(line)) return
  findings.push({ file: ctx.rel, line, rule, message, level })
}

/** 逗号分隔但不拆括号里的逗号（cubic-bezier(…)、linear(…)）。 */
function splitTop(value, sep = ',') {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 检查一条声明（CSS 与 TSX 内联样式共用）。 */
function checkDecl(ctx, prop, value, idx) {
  prop = prop.trim().toLowerCase()
  const v = value.trim()
  if (prop === 'transition' || prop === 'transition-property') {
    for (const part of splitTop(v)) {
      const first = part.split(/\s+/)[0].toLowerCase()
      if (first === 'all') report(ctx, idx, 'transition-all', `禁止 transition: all（"${part}"），请列出具体属性`)
      else if (SIZE_PROPS.has(first)) report(ctx, idx, 'size-transition', `不要对 ${first} 做过渡（"${part}"），进度 / 用量用 transform: scaleX()`)
    }
  }
  if (/\bscale(?:3d)?\(\s*0(?:\.0*)?\s*[,)]/i.test(v)) report(ctx, idx, 'scale-zero', `禁止 scale(0)（"${v}"），最小缩放 ${MIN_SCALE}`)
  else {
    for (const m of v.matchAll(/\bscale\(\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/gi)) {
      const n = Math.min(Number(m[1]), m[2] ? Number(m[2]) : Infinity)
      if (n > 0 && n < MIN_SCALE) report(ctx, idx, 'scale-too-small', `缩放 ${n} 小于 ${MIN_SCALE}`, 'warn')
    }
  }
}

function isInfinite(prop, value) {
  prop = prop.trim().toLowerCase()
  return (prop === 'animation' || prop === 'animation-iteration-count') && /\binfinite\b/i.test(value)
}

const normSel = (s) => s.replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').trim()

/** 选择器 → 复合选择器列表，每个复合选择器拆成简单选择器记号（.a、[x='y']、::after、div）。 */
function compounds(sel) {
  return sel
    .split(/[\s>+~]+/)
    .filter(Boolean)
    .map((c) => new Set(c.match(/\.[\w-]+|#[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?|^[a-z][\w-]*|^\*/gi) ?? []))
}
/**
 * reduced-motion 里的规则 r 是否覆盖动画规则 s：r 的记号都出现在 s 里，且 r 的最后一段是 s 最后一段的子集。
 * 例：`.lead-light .lead-light-dot` 覆盖 `.lead-light[data-state='working'] .lead-light-dot`。
 */
function covers(r, s) {
  const rc = compounds(r)
  const sc = compounds(s)
  if (!rc.length || !sc.length) return false
  const all = new Set(sc.flatMap((c) => [...c]))
  const lastS = sc[sc.length - 1]
  return [...rc[rc.length - 1]].every((t) => lastS.has(t)) && rc.every((c) => [...c].every((t) => all.has(t)))
}

// ---------------------------------------------------------------- CSS

function auditCss(ctx) {
  const src = ctx.src
  /** 栈：{ header, reduce } */
  const stack = []
  const infinite = [] // { selectors, idx, name }
  const reduced = new Set() // reduced-motion 块里声明了 animation* 的选择器
  let i = 0
  let buf = ''
  let bufStart = 0
  const inReduce = () => stack.some((s) => s.reduce)
  const inKeyframes = () => stack.some((s) => /^@(-webkit-)?keyframes\b/.test(s.header))
  const currentRule = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (!stack[k].header.startsWith('@')) return stack[k]
    return undefined
  }
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      const header = buf.trim()
      const reduce = /^@media\b[^{]*prefers-reduced-motion\s*:\s*reduce/i.test(header)
      const km = header.match(/^@(?:-webkit-)?keyframes\s+([\w-]+)/)
      if (km) {
        const at = { file: ctx.rel, line: lineAt(src, bufStart + buf.indexOf('@')) }
        if (!keyframes.has(km[1])) keyframes.set(km[1], [])
        keyframes.get(km[1]).push(at)
      }
      const entry = { header, reduce, selectors: header.startsWith('@') ? [] : splitTop(header).map(normSel) }
      entry.inReduce = !header.startsWith('@') && inReduce()
      stack.push(entry)
      buf = ''
      bufStart = i + 1
    } else if (ch === '}' || ch === ';') {
      const decl = buf
      const colon = decl.indexOf(':')
      if (colon > 0 && !inKeyframes() && !decl.trim().startsWith('@')) {
        const prop = decl.slice(0, colon)
        const value = decl.slice(colon + 1)
        const idx = bufStart + decl.search(/\S/)
        checkDecl(ctx, prop, value, idx)
        const rule = currentRule()
        // reduced-motion 块里声明了 animation* 的规则才算兜底
        if (rule && rule.inReduce && /^\s*animation(-[a-z-]+)?\s*$/i.test(prop)) rule.selectors.forEach((x) => reduced.add(x))
        if (rule && isInfinite(prop, value) && !inReduce()) infinite.push({ selectors: rule.selectors, idx, value: value.trim() })
      }
      if (ch === '}') stack.pop()
      buf = ''
      bufStart = i + 1
    } else buf += ch
    i++
  }
  for (const a of infinite) {
    const covered = a.selectors.length > 0 && a.selectors.every((s) => [...reduced].some((r) => covers(r, s)))
    if (!covered) report(ctx, a.idx, 'infinite-no-reduce', `无限动画（${a.selectors.join(', ') || '?'}：${a.value}）在本文件的 prefers-reduced-motion: reduce 里没有兜底，需静止且仍可见`)
  }
}

// ---------------------------------------------------------------- TSX / TS：内联样式对象与模板字符串

const JS_PROP = { transition: 'transition', transitionProperty: 'transition-property', transform: 'transform', animation: 'animation', animationIterationCount: 'animation-iteration-count', scale: 'scale' }

function auditJs(ctx) {
  const src = ctx.src
  // style={{ transition: 'width 200ms' }} / { transform: `scale(0)` }
  const re = /\b(transition|transitionProperty|transform|animation|animationIterationCount)\s*:\s*(['"`])([^'"`\n]*)\2/g
  for (const m of src.matchAll(re)) {
    const prop = JS_PROP[m[1]]
    checkDecl(ctx, prop, m[3], m.index)
    if (isInfinite(prop, m[3])) report(ctx, m.index, 'infinite-no-reduce', `内联无限动画（${m[3]}）无法在 reduced-motion 下兜底，改成 CSS 类`)
  }
  // 字符串里的 CSS 片段（如 `transition: all 0.2s`）
  for (const m of src.matchAll(/(['"`])[^'"`\n]*?\b(transition(?:-property)?)\s*:\s*([^;'"`\n]+)[^'"`\n]*\1/g)) {
    checkDecl(ctx, m[2], m[3], m.index)
  }
}

// ---------------------------------------------------------------- main

const files = targets.flatMap((t) => walk(t))
for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  const allow = new Set()
  const src = stripComments(raw, allow)
  const ctx = { file, rel: relative(ROOT, file), src, allow }
  if (file.endsWith('.css')) auditCss(ctx)
  else auditJs(ctx)
}
for (const [name, defs] of keyframes) {
  if (defs.length < 2) continue
  const where = defs.map((d) => `${d.file}:${d.line}`).join('、')
  for (const d of defs) findings.push({ file: d.file, line: d.line, rule: 'dup-keyframes', message: `@keyframes ${name} 重名（${where}），全局 CSS 会互相覆盖`, level: 'error' })
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
const errors = findings.filter((f) => f.level === 'error')
if (asJson) {
  process.stdout.write(JSON.stringify({ files: files.length, errors: errors.length, findings }, null, 2) + '\n')
} else {
  for (const f of findings) console.log(`${f.level === 'error' ? '✗' : '!'} ${f.file}:${f.line}  [${f.rule}] ${f.message}`)
  const warns = findings.length - errors.length
  console.log(`\nmotion-audit：扫描 ${files.length} 个文件，${errors.length} 个违规${warns ? `，${warns} 个提醒` : ''}${errors.length ? '' : '，通过'}`)
}
process.exit(errors.length ? 1 : 0)
