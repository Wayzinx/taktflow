---
name: taktflow 控制台
description: 按节拍推进的 AI 交付流水线的观察与干预面
colors:
  paper: "oklch(0.972 0.004 80)"
  paper-sunken: "oklch(0.948 0.005 80)"
  surface: "oklch(0.995 0.002 80)"
  graphite-night: "oklch(0.165 0.005 75)"
  graphite-surface: "oklch(0.198 0.006 75)"
  console-rail: "oklch(0.215 0.007 70)"
  console-rail-night: "oklch(0.135 0.005 75)"
  ink: "oklch(0.215 0.008 70)"
  ink-2: "oklch(0.43 0.01 70)"
  ink-3: "oklch(0.52 0.01 70)"
  takt-orange: "oklch(0.62 0.17 47)"
  takt-orange-night: "oklch(0.72 0.155 52)"
  status-success: "oklch(0.5 0.12 155)"
  status-running: "oklch(0.5 0.15 252)"
  status-failed: "oklch(0.52 0.19 22)"
  status-waiting: "oklch(0.5 0.12 70)"
  status-stale: "oklch(0.5 0.13 300)"
typography:
  display:
    fontFamily: "IBM Plex Sans, PingFang SC, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "IBM Plex Sans, PingFang SC, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  title:
    fontFamily: "IBM Plex Sans, PingFang SC, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "IBM Plex Sans, PingFang SC, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  ui:
    fontFamily: "IBM Plex Sans, PingFang SC, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  meta:
    fontFamily: "IBM Plex Sans, PingFang SC, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Sans, PingFang SC, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.06em"
  code:
    fontFamily: "IBM Plex Mono, SF Mono, PingFang SC, monospace"
    fontSize: "max(11px, 0.93em)"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 12px"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 12px"
  nav-item-active:
    backgroundColor: "oklch(0.33 0.009 70)"
    textColor: "oklch(0.93 0.006 80)"
    rounded: "{rounded.sm}"
    height: "32px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  command-palette:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    width: "640px"
  drawer:
    backgroundColor: "{colors.surface}"
    rounded: "0"
    width: "440px"
  toast:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    width: "440px"
---

# Design System: taktflow 控制台

> 规范源是 `packages/web/src/styles/tokens.css`。改 token 先改那里，再同步本文件。

## Overview

**Creative North Star: "节拍控制室"（The Takt Control Room）**

taktflow 的控制台像一间精密仪器的控制室：深石墨的控制导轨固定在左侧，暖白的工作台面上摆着需求、运行和节点；绝大部分时间画面是安静的，只有真实发生的事情才会发光、跳动。节拍（takt）是唯一的母题：流水线按拍子推进，界面里一切"活着"的东西都跟着同一拍（`--takt: 1200ms`）走。

这是一个 Operate 面：用户来这里完成任务（看清卡在哪、做决定、让流水线继续）。导航、表格、Tab、抽屉都用人们已经熟悉的标准控件；世界观只通过四样东西进入：字体（IBM Plex 的工程气质）、配色（石墨 + 暖纸 + 一点节拍橙）、密度（13px 的控制台字号，信息紧凑但有呼吸），以及一个签名动作——**节拍尺**。

明确拒绝：紫蓝渐变的 AI 落地页、玻璃拟态、大面积发光、没有状态含义的装饰动画、侧边粗色条卡片。

**Key Characteristics:**
- 深石墨控制导轨（浅色、深色主题都是深色），工作区是暖白纸面 / 暖石墨夜间面；
- 节拍橙只出现在品牌标、"当前位置"刻度、焦点环、节拍指示上，屏幕占比 < 5%；
- 状态色只表达状态，并且永远配图标或文字；
- 小圆角（3–10px）、细描边、凸起面带一道机加工高光；
- 动效全部服从同一拍子，并尊重 `prefers-reduced-motion`。

## Colors

石墨与暖纸构成中性底，节拍橙是唯一的品牌色，状态色是一套独立的语义层。全部写成 OKLCH，深浅主题用 `light-dark()` 在同一个 token 里给出两值。

### Primary
- **节拍橙 Takt Orange**（`oklch(0.62 0.17 47)`；夜间 `oklch(0.72 0.155 52)`）：品牌标的最后一拍、导航与命令面板的"当前位置"刻度、焦点环（`--accent-ring`）、顶栏节拍指示与传送带光点、待办计数角标。不用于大块底色，不用于主按钮。
- **墨 Ink**（`oklch(0.215 0.008 70)`；夜间反转为 `oklch(0.93 0.006 80)`）：主按钮底色、正文。主操作靠墨色的分量而不是彩色来突出。

### Neutral
- **暖纸 Paper**（`oklch(0.972 0.004 80)`）：浅色工作区底。
- **纸面 Surface**（`oklch(0.995 0.002 80)`）：卡片、表格、浮层。
- **石墨夜 Graphite Night**（`oklch(0.165 0.005 75)`）/ **石墨面**（`oklch(0.198 0.006 75)`）：深色工作区底与卡片。
- **控制导轨 Console Rail**（`oklch(0.215 0.007 70)`；夜间 `oklch(0.135 0.005 75)`）：侧栏，两套主题都是深色；导轨内文字用 `--rail-text*` 三级。
- **墨 2 / 墨 3**（`oklch(0.43 …)` / `oklch(0.52 …)`）：次要文字与元信息，均满足 AA。

### 状态色（Semantic）
- **成功** `oklch(0.5 0.12 155)`、**运行中** `oklch(0.5 0.15 252)`、**失败** `oklch(0.52 0.19 22)`、**等人** `oklch(0.5 0.12 70)`、**过期** `oklch(0.5 0.13 300)`、**跳过 / 未开始** 中性灰。每个都有 `-soft` 版本做徽章底色。
- 数据系列 `--c-1…--c-8` 用于上下文来源堆叠条与判决类别，色相与状态色错开。

### Named Rules
**The Quiet Until Live Rule.** 没有在运行的东西，画面就不发光、不跳动。节拍橙和脉动只出现在真实"活着"的地方。

**The Ink Not Paint Rule.** 主按钮是墨色，不是品牌色。品牌色留给节拍，它的稀少就是重点。

**The Never Color Alone Rule.** 状态永远是"颜色 + 图标"或"颜色 + 文字"，色弱用户和灰度打印都能读懂。

## Typography

**Body Font:** IBM Plex Sans（拉丁、数字），中文回落 PingFang SC / 微软雅黑
**Label/Mono Font:** IBM Plex Mono（REQ-001、run id、路径、模型名、键位）

**Character:** Plex 出自工程制图传统，字形克制、数字清楚，和中文黑体放在一起不抢戏；等宽体让标识符像仪表读数。

### Hierarchy
- **Display**（600，28px，1.15）：关键数字（总览统计、度量）。
- **Headline**（600，20px，1.3）：页面标题，每页一个。
- **Title**（600，16px，1.4）：抽屉、对话框标题。
- **Body**（400，14px，1.6）：可读段落：评审意见、产物正文、群聊，行宽 ≤ 72ch。
- **UI**（400/500，13px，1.55）：控件、表格、导航——控制台的默认字号。
- **Meta**（400，12px）：时间、计数、次要说明。
- **Label**（600，11px，字距 0.06em）：分组标题、角标。11px 是全站下限。
- **Code**（Plex Mono，`max(11px, 0.93em)`）：所有标识符，开启等宽数字。

### Named Rules
**The 11px Floor Rule.** 任何承载信息的文字不小于 11px；放不下就换表达（例如 14px 头像只留色块，名字进 title）。

**The Identifier Is Mono Rule.** 原文标识符一律等宽显示，中文术语一律用无衬线。

## Layout

- 外壳：左侧 248px 控制导轨（品牌、空间切换器 + 管家 / 搜索 / 收起三个图标按钮、主导航、最近需求、主题切换；⌘B 收为 60px 图标导轨）+ 右侧工作区；顶栏 52px 吸顶，含面包屑、数据来源标记、节拍指示、⌘K 按钮。
- 工作区内边距 24px / 32px；窄于 900px 时导轨收为抽屉（汉堡按钮打开、点遮罩或路由变化关闭），面包屑只留当前页。
- 间距：布局一律按 **8px 网格**（8 / 16 / 24 / 32 / 48 / 64，`--sp-2/4/6/8/12/16`）；4 / 12 / 20 只用于控件内部微调。同组元素 8px，组与组 16–24px，区块之间 24–32px。少套框，多用间距与色调分组。
- 表格行高 44px，导航行高 32px，命令面板行高 38px。

## Elevation & Depth

层次以色调分层为主、阴影为辅：暖纸底 → 纸面卡片 → 浮层。凸起面有一道 1px 的内高光（`--edge-light`），像机加工件的倒角；阴影低而利落，不做漫射光晕。

### Shadow Vocabulary
- **sm**（`inset 0 1px 0 var(--edge-light), 0 1px 2px var(--shadow-color), 0 0 0 1px var(--border)`）：卡片、按钮、空状态图标。
- **md**（`0 6px 18px -6px …, 0 2px 5px -2px …, 0 0 0 1px var(--border)`）：悬浮卡片、下拉。
- **lg**（`0 28px 60px -16px …, 0 10px 20px -10px …, 0 0 0 1px var(--border-strong)`）：命令面板、抽屉、窄屏导轨。

### 三层表面（M4）
| 层 | 底色 | 阴影 token | 用途 |
|---|---|---|---|
| 页面底 | `--bg` | 无 | 工作区背景 |
| 卡片 | `--surface` / `--surface-raised` | `--elev-1` | 卡片、表格容器、空状态图标 |
| 浮层 | `--surface-overlay` | `--elev-2`（下拉、菜单、气泡）/ `--elev-3`（对话框、抽屉、停靠面板、⌘K、toast） | 浮在内容之上的一切 |

浅色主题靠细阴影区分层次；深色主题阴影几乎看不见，所以**浮层更亮（`--surface-overlay`）+ 描边更实（`--border-strong`）**。三个 `--elev-*` 都自带 1px 描边与顶部内高光，不要再叠 `border`。

### Named Rules
**The Flat At Rest Rule.** 静止的表面只用 elev-1；只有浮在内容之上的东西用 elev-2 / elev-3。

## Shapes

圆角刻度 **6 / 10 / 14**（`--r-sm` / `--r-md` / `--r-lg`；旧名 `--radius-sm` / `--radius` / `--radius-lg` 指向它们）：按钮、输入、标签、菜单项 6px，卡片与面板 10px，浮层（对话框、抽屉、⌘K、toast）14px；角标与行内代码 4px（`--radius-xs`），计数角标用胶囊。字号刻度 **12 / 13 / 14 / 16 / 20 / 28**（11px 只给分组标题与角标）。描边 1px，深浅主题都用半透明暖灰。不使用单侧粗色条；"当前位置"用 2–3px 的节拍刻度表达，只出现在导航与命令面板的选中行。

## Components

### Buttons
- **Shape:** 5px 圆角，高 30px（小号 26px）。
- **Primary:** 墨色底、反白文字、内高光；hover 变浅一级。
- **Default:** 纸面底 + strong 描边；hover 换 `--surface-hover`。
- **Press:** 所有按钮按下 `scale(.98)`，80ms（`--dur-press`）；非 `.btn` 的可点元素加 `.pressable`。
- **Ghost:** 无底无边，hover 才出现底色。
- **Focus:** 2px 节拍橙焦点环，偏移 2px，120ms 淡入（`--dur-focus`）。
- **强调色**（takt-orange）只用于两处：主动作的焦点 / 选中记号，以及实时状态（运行中、思考中、流式光标、未读角标）。

### Navigation（控制导轨）
- 导轨深石墨；条目 13px/500，图标 16px、描边 1.75。
- hover：`--rail-hover` 底；当前页：`--rail-active` 底 + 左缘 3px 节拍橙刻度 + 图标变橙，`aria-current="page"`。
- 待办数用节拍橙胶囊角标；其他计数用 rail-text-3 等宽数字。
- 底部：三段主题切换（跟随系统 / 浅色 / 深色）与版本号。

### 顶栏与面包屑
- 半透明暖纸底 + 模糊；面包屑是 `<ol>`，分隔用 chevron，当前页 500 字重。
- 右侧：演示数据（虚线中性描边，不是告警）、节拍指示（"N 个需求在跑"，有运行时橙点按拍子跳）、⌘K 按钮。

### 命令面板（⌘K / Ctrl+K）
- 640px 宽、10px 圆角、lg 阴影，从顶部 12vh 处出现（200ms 淡入 + 6px 下落，150ms 退出）。
- 分组：页面 / 查询 / 命令 / 需求 / 运行 / 操作（主题切换）；多词全命中过滤，标识前缀命中排前，分组按组内最佳匹配排序。
- 查询 / 命令来自 `/api/commands`：风险用图标（只读 眼睛 / 写入 笔 / 危险 盾牌，危险用失败色）；选中后进入按 input schema 生成的表单，需求 / 运行 / 节点从当前页面自动带入（标"来自当前页面"）；write / dangerous 必须写原因；⌘↵ 执行，Esc 返回列表。别的界面用 `openCommand(id, input)` 直接打开某条命令。
- 选中行：hover 底 + 左缘 2px 节拍橙刻度 + 回车图标；↑↓ 选择、↵ 打开、Esc 关闭，关闭后焦点回到触发处。

### 节拍尺（Signature）
- 一排 2px 刻度，每 4 格一根长刻度。
- **运行中**：光点按拍子逐格点亮（传送带）；顶栏下沿的刻度带上，一段橙色光带按 `steps()` 一格格推进。
- **加载**（`TaktLoader`）：节拍尺快拍（110ms 一格）+ 一句说明在等什么；120ms 后才淡入，快速返回不闪。
- **空状态**（`EmptyState`）：图标 + 标题 + 说明 + 可选操作，底部一把静止的节拍尺，表示"这里没有在跑的东西"。

### Cards / Containers
- 7px 圆角、纸面底、sm 阴影；卡片头 44px，标题 13px/600。

### Inputs
- 5px 圆角、strong 描边；focus 时描边变节拍橙 + 3px 柔和外环。

## Motion

规范来源：`docs/dev/m3-web.md`「动效规范」；`npm run motion:audit -w @taktflow/web` 在 CI 里检查。

### 曲线与时长
- 曲线：`--ease`（`cubic-bezier(0.22, 1, 0.36, 1)`，快出稳停，默认）；`--ease-in-out`（循环节律）；`--ease-spring`（`linear()` 弹簧近似，只用于抽屉与窄屏导轨这类"有质量"的面板）。退出用加速曲线（先慢后快），让东西"走开"而不是"停下"。
- 时长 token（`styles/tokens.css`）：

| token | 值 | 用途（规范区间） |
|---|---|---|
| `--dur-press` | 100ms | 直接反馈：按下、勾选、切换（80–120） |
| `--dur-fast` | 110ms | hover 颜色 / 底色 |
| `--dur-pop` / `--dur-pop-exit` | 150 / 120ms | 下拉、气泡、菜单、列表项、toast（120–180） |
| `--dur` | 160ms | 一般状态切换 |
| `--dur-enter` / `--dur-exit` | 200 / 150ms | 对话框、⌘K 进 / 出（进 180–220，出 120–180） |
| `--dur-slow` | 320ms | 只给抽屉与窄屏导轨（配 `--ease-spring`） |
| `--takt` | 1200ms | 一拍：所有节律类动画以它为单位 |

### 幅度
- 位移 2–8px；缩放不低于 0.985；禁止 `scale(0)`、禁止 `transition: all`。
- **进度条 / 用量条用 `transform: scaleX()`**（`.meter > .meter-fill`，`--meter` 取 0..1；`<Meter>` 组件同），不动画 width / height。

### 进出场
- 弹层、对话框、⌘K、下拉、抽屉、toast 都有退出动画：用 `lib/motion.tsx` 的 `usePresence(open, exitMs)` 保留卸载前的最后一帧，退出途中重开直接折返（用过渡而不是关键帧，所以能从当前位置打断）。
- 样式写在 `data-state`：`enter`（初始）/ `open`（常态）/ `exit`（退出）。现成的类：`.presence-pop`（150 进 / 120 出，4px + 0.985）、`.presence-dialog`（200 进 / 150 出，6px + 0.985）、`.presence-scrim`（遮罩淡入淡出）。
- 原语：`components/ui` 的 `Dialog`、`Popover`、`Menu`、`ReasonDialog`（write / dangerous 操作的原因输入）都已接好进出场、Esc、焦点还原。

### 节律
- 运行中的状态点、节拍指示按 `takt-beat` 跳：拍头放大 1.35 倍，然后回落——像节拍器，不是呼吸灯。
- 运行中的标题用 `.shimmer-text`（两拍扫一次的窄亮带：文字保持实色，用遮罩让其余部分半透明，不用渐变文字）；跳转定位用 `.jump-highlight`（2.4s 淡出）。

### 不加动画的地方
- 拖拽本体严格跟手，不加缓动；流式文本、虚拟列表行、频繁更新的计数不加入场动画。
- hover 放大 / 上浮只在 `(hover: hover) and (pointer: fine)` 下生效（`.hover-lift`）。

### 减少动态效果
- `prefers-reduced-motion: reduce`：无限动画（脉动、闪烁、扫光、传送带）**静止且仍可见**——每个无限动画在自己的 CSS 文件里写兜底（`motion:audit` 检查）；进出场只保留透明度，去掉位移与缩放；过渡瞬时完成；信息不依赖动效。

### M4 体验基线（docs/dev/m4-web.md；原语在 `components/ui/`，用法见 `packages/web/OWNERSHIP.md`）
| 场景 | 规格 | 实现 |
|---|---|---|
| 页头 | 标题 + 一句说明 + 右侧主动作 + 说明下方最多 3 个管家建议胶囊 | `<PageHeader title description actions suggestions />` |
| 加载 | 骨架贴近真实布局，超过 120ms 才淡入，扫光；禁止"…""加载中"文字 | `<Skeleton>` / `SkeletonRows` / `SkeletonText` / `SkeletonCard` / `SkeletonGrid`；`ux:audit` 检查 |
| 空 / 错误 | 一句话 + 一个主动作 + "让管家帮我"；错误说明原因 + 重试，403 说明找谁 | `<EmptyState icon title body action stewardAsk />`、`<ErrorState error onRetry />` |
| 成功 | 底部居中升起，5s 消失（悬停暂停），最多 3 条，能撤销就带撤销 | `toast(msg, { undo, tone })` + `<Toaster>` |
| 路由切换 | 旧页淡出 120ms；新页淡入 + 上移 6px，200ms，`--ease-out-soft`；共享元素用 `view-transition-name` | View Transitions（`lib/router`）+ `<PageTransition>`、`vtName()` |
| Tab | 指示器 transform 平移，内容淡入 150ms | `<Tabs>` + `<TabPanel key={tab}>` |
| 列表首屏 | 每项间隔 24ms、最多 10 项、单项 160ms；之后的更新不入场 | `useStagger(n)` |
| 新行 | 底色闪一下，1.2s 淡出 | `useFlashRows(keys)` → `.flash-row` |
| 数字 | 旧值 → 新值 400ms，等宽数字；首屏从 0 只给总览 | `<CountUp value from0 />` |
| 运行中 / 思考中 / 流式 / 展开 | 节拍呼吸外环 / 扫光 / 光标闪烁 / `grid-template-rows: 0fr → 1fr` | `.live-ring` / `.shimmer-text` / `.stream-caret` / `.expand[data-open]` |
| 抽屉 / 停靠面板 | 右侧 `translateX(16px)` + 淡入 220ms，退出 160ms；停靠面板在 ≥1280px 时把工作区让出 440px（宽度变化不做过渡），窄屏浮在页面上 | `<Drawer>`（`mode` 取 `modal` 或 `dock`）；`.shell[data-dock='open']` |
| 快捷键 | ⌘J 管家、⌘K 命令面板、C 新建需求（不在输入框时）、⌘B 收起侧栏；写进按钮 tooltip | `lib/shortcuts`、`<Kbd combo />`、`withShortcut()` |

新增时长 token：`--dur-route-out` 120 / `--dur-route-in` 200 / `--dur-tab` 150 / `--dur-item` 160 / `--stagger-step` 24 / `--dur-count` 400 / `--dur-flash` 1200 / `--dur-dock` 220 / `--dur-focus` 120 / `--skeleton-delay` 120（ms）；曲线 `--ease-out-soft: cubic-bezier(.2,.8,.2,1)`。reduced-motion 下这些都只保留透明度（`styles/motion.css` 用 `!important` 压过全局兜底），无限动画静止但可见。

## Iconography

lucide-react，线性图标；导航 16px / 描边 1.75，正文与按钮 14px，徽章 12px。图标只做识别，不做装饰；状态图标与状态色成对出现。

## Do's and Don'ts

### Do:
- **Do** 从 `tokens.css` 取所有颜色、字号、间距、圆角、阴影、时长；新增 token 先加到那里。
- **Do** 让"运行中"的一切跟随 `--takt` 同一拍。
- **Do** 异步区域四种状态齐全：骨架（形状贴近真实布局）、空（一句话 + 一个主动作 + 让管家帮我）、错误（原因 + 重试）、成功（toast，能撤销就带撤销）。整页首屏的 `TaktLoader` 仍可写清在等什么。
- **Do** 在深色主题里用 `light-dark()` 的第二个值，而不是单独写一套选择器。

### Don't:
- **Don't** 用紫蓝渐变、玻璃拟态、发光描边或大面积品牌色。
- **Don't** 用节拍橙做主按钮或大块背景。
- **Don't** 做单侧粗色条卡片；需要分类就用徽章、图标或细描边着色。
- **Don't** 让任何承载信息的文字小于 11px。
- **Don't** 加没有状态含义的循环动画。
- **Don't** 在页面文案里教用户改 `takt.config.json` 或跑 `takt …` 命令——给按钮，或"让管家帮我"（`ux:audit` 警告）。
