#!/usr/bin/env node
/**
 * 版面验收（docs/design/30 §验收）：在真浏览器里把主要页面和常开的浮层都打开一遍，找人眼一看就会皱眉的问题。
 * ux-audit 只看源码；这个看渲染结果：
 *   covered    可点的元素或标题被别的东西盖住（中心点 elementFromPoint 打到的不是它自己）。开着模态时只查模态里面
 *   clipped    可点的元素被不能滚动的祖先裁掉一截（露出不到 90%）
 *   page-x     页面出现横向滚动条
 *   spill      文字溢出自己的盒子又没有省略号（overflow 可见、scrollWidth 比宽度大）
 *   overlap    两段不相干的文字压在一起
 *   field-cut  窄输入框 / 下拉框（200px 以内）里的值显示不全
 * 每个页面在亮色、暗色两种主题，宽屏 1440 和窄屏 1100 两种宽度下各查一遍，截图存到 --out，问题位置画红框。
 *
 * 用法：npm run ux:layout -w @taktflow/web -- [--base http://localhost:5199] [--space standard-delivery] [--out dir] [--only 关键字]
 * 需要一个跑着的 takt serve（或代理到它的 vite）；浏览器用本机 Chrome（--chrome-path 指定别的）。有问题时退出码 1。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const base = opt('base', 'http://127.0.0.1:4870').replace(/\/$/, '')
const space = opt('space', 'standard-delivery')
const out = resolve(opt('out', '.ux-layout'))
const only = opt('only')
const chromePath = opt('chrome-path')

const api = async (path) => (await fetch(`${base}/api/s/${space}${path}`)).json()
const reqs = await api('/requirements').catch(() => [])
const req = (Array.isArray(reqs) ? reqs : reqs.items ?? []).find((r) => r.latestRunId) ?? (Array.isArray(reqs) ? reqs : [])[0]
const wfs = await api('/workflows').catch(() => [])
const wf = (Array.isArray(wfs) ? wfs : []).sort((a, b) => (b.nodes ?? 0) - (a.nodes ?? 0))[0]

/** 页面和要额外打开的浮层：open 是在页面里依次点的按钮（按可见文字或 aria-label 找），click 是依次点的元素（CSS 选择器）。 */
const S = `/s/${space}`
const PAGES = [
  { name: '总览', path: `${S}/` },
  { name: '需求列表', path: `${S}/requirements` },
  req && { name: '需求详情', path: `${S}/req/${req.id}` },
  req?.latestRunId && { name: '运行页', path: `${S}/run/${req.latestRunId}` },
  { name: '待办', path: `${S}/attention` },
  { name: '知识库', path: `${S}/knowledge` },
  { name: '流水线列表', path: `${S}/workflows` },
  wf && { name: '流水线编辑', path: `${S}/workflows/${wf.id}` },
  wf && { name: '流水线节点属性', path: `${S}/workflows/${wf.id}`, click: ['.react-flow__node .k-agent'] },
  wf && { name: '流水线修订历史', path: `${S}/workflows/${wf.id}`, open: ['修订历史'] },
  // 窄屏时管家停靠面板浮在页面上、本来就会盖住工具栏，只在宽屏查
  wf && { name: '流水线修订历史 + 管家', path: `${S}/workflows/${wf.id}`, open: ['问管家', '修订历史'], minWidth: 1280 },
  { name: '评测', path: `${S}/eval` },
  { name: '自动化', path: `${S}/automations` },
  ...['members', 'repos', 'skills', 'agents', 'shared', 'workflows', 'knowledge', 'lessons', 'runtime', 'quality'].map((tab) => ({ name: `空间设置 ${tab}`, path: `${S}/settings/${tab}` })),
  { name: '技能导入', path: `${S}/settings?tab=skills`, open: ['导入技能'] },
  { name: '技能添加文件', path: `${S}/settings?tab=skills`, open: ['添加文件'] },
  { name: '管家 Solo', path: `${S}/solo` },
  { name: '命令面板', path: `${S}/`, keys: ['Meta+K'] },
].filter(Boolean).filter((p) => !only || p.name.includes(only))

const VIEWS = [
  { theme: 'light', width: 1440, height: 900 },
  { theme: 'dark', width: 1440, height: 900 },
  { theme: 'light', width: 1100, height: 800 },
]

/** 在页面里跑的检查；返回问题列表，每条带框（画红框用）。 */
function probe() {
  const issues = []
  const vw = innerWidth, vh = innerHeight
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? ` 「${t}」` : ''}`
  }
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width >= 4 && r.height >= 4 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw
  }
  /**
   * 祖先把元素裁剩多少，以及是不是被一个滚不动的祖先裁掉的。
   * 中间隔着能滚动的容器就不算（滚一下就看见了，比如长列表在首屏下面的那几行）。
   */
  const clipOf = (el) => {
    let r = el.getBoundingClientRect()
    const area = r.width * r.height
    let rect = { l: r.left, t: r.top, r: r.right, b: r.bottom }
    let clipper
    let scrolled = false
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      const scrolls = /(auto|scroll)/.test(s.overflowX + s.overflowY)
      if (!scrolls && !/(hidden|clip)/.test(s.overflowX + s.overflowY)) continue
      const pr = p.getBoundingClientRect()
      const next = { l: Math.max(rect.l, pr.left), t: Math.max(rect.t, pr.top), r: Math.min(rect.r, pr.right), b: Math.min(rect.b, pr.bottom) }
      if (!scrolls && !scrolled && (next.r - next.l) * (next.b - next.t) < (rect.r - rect.l) * (rect.b - rect.t) - 1) clipper ??= p
      scrolled ||= scrolls
      rect = next
      if (rect.r <= rect.l || rect.b <= rect.t) break
    }
    const shown = Math.max(0, rect.r - rect.l) * Math.max(0, rect.b - rect.t)
    return { rect, ratio: area ? shown / area : 1, clipper }
  }
  /** 吸顶 / 吸底 / 固定的那一层（顶栏、表单底部的保存条） */
  const pinned = (n) => {
    for (; n && n !== document.body; n = n.parentElement) if (/^(sticky|fixed)$/.test(getComputedStyle(n).position)) return n
  }
  const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .ov-pop'
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].filter(visible).at(-1)
  const scope = modal ?? document.body

  // covered / clipped：可点的和标题
  const targets = [...scope.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"], h1, h2, h3')].filter(visible)
  for (const el of targets) {
    if (el.closest('[aria-hidden="true"], .react-flow__minimap, [inert]')) continue
    const { rect, ratio, clipper } = clipOf(el)
    if (ratio <= 0) continue
    if (clipper && ratio < 0.9 && !el.matches('input, textarea')) issues.push({ rule: 'clipped', what: label(el), detail: `露出 ${Math.round(ratio * 100)}%，被 ${label(clipper)} 裁掉`, box: box(el.getBoundingClientRect()) })
    const x = (rect.l + rect.r) / 2, y = (rect.t + rect.b) / 2
    if (x < 0 || y < 0 || x >= vw || y >= vh) continue
    const hit = document.elementFromPoint(x, y)
    if (!hit || el.contains(hit) || hit.contains(el)) continue
    // label 包着的 input、自定义控件里的装饰层不算
    if (hit.closest('label')?.contains(el) || el.closest('label')?.contains(hit)) continue
    // 正文滚到吸顶栏、吸底保存条下面是正常的；浮层（对话框、抽屉、菜单）里的东西被盖住才算
    if (!el.closest(OVERLAY) && pinned(hit) && !pinned(el)) continue
    issues.push({ rule: 'covered', what: label(el), detail: `被 ${label(hit)} 盖住`, box: box(el.getBoundingClientRect()) })
  }

  // field-cut：窄的输入框、下拉框装不下当前值（宽的长文本框本来就会滚，不算）
  const ctx = document.createElement('canvas').getContext('2d')
  for (const el of scope.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), select')) {
    if (!visible(el) || el.clientWidth > 200) continue
    const s = getComputedStyle(el)
    const text = el.tagName === 'SELECT' ? el.selectedOptions[0]?.textContent ?? '' : el.value
    if (!text) continue
    ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
    const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - (el.tagName === 'SELECT' ? 18 : 0)
    if (ctx.measureText(text).width > room + 1) issues.push({ rule: 'field-cut', what: label(el), detail: `「${text}」放不下（要 ${Math.round(ctx.measureText(text).width)}px，框里只有 ${Math.round(room)}px）`, box: box(el.getBoundingClientRect()) })
  }

  // page-x
  const se = document.scrollingElement
  if (se && se.scrollWidth > vw + 1) issues.push({ rule: 'page-x', what: 'document', detail: `页面宽 ${se.scrollWidth}px，超出窗口 ${se.scrollWidth - vw}px`, box: { x: 0, y: 0, w: vw, h: 4 } })

  // spill：文字溢出自己的盒子
  const texts = [...scope.querySelectorAll('body *')].filter((el) => el.childElementCount === 0 && el.textContent.trim() && visible(el))
  for (const el of texts) {
    const s = getComputedStyle(el)
    if (s.overflowX !== 'visible' || s.textOverflow === 'ellipsis' || s.display === 'inline') continue
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const { ratio } = clipOf(el)
      if (ratio > 0) issues.push({ rule: 'spill', what: label(el), detail: `文字宽 ${el.scrollWidth}px，盒子只有 ${el.clientWidth}px`, box: box(el.getBoundingClientRect()) })
    }
  }

  // overlap：不相干的两段文字压在一起（只比较文字真正占、又没被祖先裁掉的那一截）
  const runs = []
  for (const el of texts) {
    if (el.closest('svg, .react-flow__edge, [aria-hidden="true"]')) continue
    const { rect: c } = clipOf(el)
    const range = document.createRange()
    range.selectNodeContents(el)
    for (const t of range.getClientRects()) {
      const r = { left: Math.max(t.left, c.l), top: Math.max(t.top, c.t), right: Math.min(t.right, c.r), bottom: Math.min(t.bottom, c.b) }
      r.width = r.right - r.left; r.height = r.bottom - r.top
      if (r.width > 2 && r.height > 2) runs.push({ el, r })
    }
  }
  for (let i = 0; i < runs.length && issues.length < 400; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j]
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (w > 3 && h > Math.min(a.r.height, b.r.height) * 0.4) {
        issues.push({ rule: 'overlap', what: label(a.el), detail: `和 ${label(b.el)} 压在一起`, box: box(a.r) })
      }
    }
  }
  return issues
}

/** 在截图上画红框（注入一层绝对定位的框，截完再删）。 */
function mark(boxes) {
  const layer = document.createElement('div')
  layer.id = '__ux_layout_marks'
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  for (const b of boxes) {
    const d = document.createElement('div')
    d.style.cssText = `position:absolute;left:${b.x - 2}px;top:${b.y - 2}px;width:${b.w + 4}px;height:${b.h + 4}px;border:2px solid #e11d48;border-radius:4px`
    layer.append(d)
  }
  document.body.append(layer)
}

const browser = await chromium.launch(chromePath ? { executablePath: chromePath } : { channel: 'chrome' })
await mkdir(out, { recursive: true })
const report = []
for (const view of VIEWS) {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: view.theme, deviceScaleFactor: 1 })
  // 主题跟系统走：colorScheme 已经切了；清掉手动选过的主题
  await context.addInitScript(() => { try { localStorage.removeItem('takt.theme') } catch {} })
  const page = await context.newPage()
  for (const p of PAGES.filter((p) => !p.minWidth || view.width >= p.minWidth)) {
    const id = `${p.name}-${view.theme}-${view.width}`.replace(/[\s/]+/g, '_')
    try {
      await page.goto(base + p.path, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15000 }).catch(() => {})
      for (const text of p.open ?? []) {
        const target = page.getByRole('button', { name: text }).first()
        await target.click({ timeout: 5000 })
        await page.waitForTimeout(500)
      }
      for (const selector of p.click ?? []) {
        await page.locator(selector).first().click({ timeout: 5000 })
        await page.waitForTimeout(400)
      }
      for (const key of p.keys ?? []) { await page.keyboard.press(key); await page.waitForTimeout(400) }
      await page.waitForTimeout(600) // 入场动效播完
      const issues = await page.evaluate(probe)
      if (issues.length) await page.evaluate(mark, issues.map((i) => i.box))
      await page.screenshot({ path: join(out, `${id}.png`) })
      if (issues.length) await page.evaluate(() => document.getElementById('__ux_layout_marks')?.remove())
      report.push({ page: p.name, path: p.path, ...view, screenshot: `${id}.png`, issues })
      console.log(`${issues.length ? '✗' : '✓'} ${p.name} · ${view.theme} · ${view.width}${issues.length ? `：${issues.length} 处` : ''}`)
      for (const i of issues.slice(0, 12)) console.log(`    ${i.rule.padEnd(7)} ${i.what} —— ${i.detail}`)
      if (issues.length > 12) console.log(`    …还有 ${issues.length - 12} 处，见报告`)
    } catch (error) {
      report.push({ page: p.name, path: p.path, ...view, error: String(error).split('\n')[0] })
      console.log(`! ${p.name} · ${view.theme} · ${view.width}：打不开 —— ${String(error).split('\n')[0]}`)
    }
  }
  await context.close()
}
await browser.close()
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2))
const total = report.reduce((n, r) => n + (r.issues?.length ?? 0), 0)
const broken = report.filter((r) => r.error).length
console.log(`\n${report.length} 个页面状态，${total} 处版面问题${broken ? `，${broken} 个打不开` : ''}。截图和 report.json 在 ${out}`)
process.exit(total || broken ? 1 : 0)
