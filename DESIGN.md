---
name: taktflow 控制台
description: 按节拍推进的 AI 交付流水线的观察与干预面
colors:
  paper: "oklch(0.972 0.004 80)"
  paper-sunken: "oklch(0.948 0.005 80)"
  surface: "oklch(0.995 0.002 80)"
  graphite-night: "oklch(0.165 0.005 75)"
  graphite-surface: "oklch(0.198 0.006 75)"
  console-rail: "oklch(0.948 0.004 80)"
  console-rail-night: "oklch(0.2 0.006 75)"
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
  md: "14px"
  lg: "18px"
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

taktflow 的控制台像一间精密仪器的控制室：控制导轨固定在左侧，工作台面像一块嵌进机身的面板，上面摆着需求、运行和节点；绝大部分时间画面是安静的，只有真实发生的事情才会发光、跳动。节拍（takt）是唯一的母题：流水线按拍子推进，界面里一切"活着"的东西都跟着同一拍（`--takt: 1200ms`）走。

这是一个 Operate 面：用户来这里完成任务（看清卡在哪、做决定、让流水线继续）。导航、表格、Tab、抽屉都用人们已经熟悉的标准控件；世界观只通过四样东西进入：字体（IBM Plex 的工程气质）、配色（石墨 + 暖纸 + 一点节拍橙）、密度（13px 的控制台字号，信息紧凑但有呼吸），以及一个签名动作——**节拍尺**。

明确拒绝：紫蓝渐变的 AI 落地页、玻璃拟态、大面积发光、没有状态含义的装饰动画、侧边粗色条卡片。

**Key Characteristics:**
- 控制导轨跟随主题（浅色暖灰 / 深色石墨），工作区是嵌在外壳里的圆角面板：暖白纸面 / 暖石墨夜间面（docs/design/29）；
- 节拍橙只出现在品牌标、"当前位置"刻度、焦点环、节拍指示上，屏幕占比 < 5%；
- 状态色只表达状态，并且永远配图标或文字；
- 圆角 6 / 14 / 18px（角标 4px）、柔和描边环 + 低漫射阴影、凸起面带一道机加工高光；
- 可视化优先（docs/design/24）：每页一个视觉主角（读数格、泳道、条形），文字只做标签与一句结论；
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
- **控制导轨 Console Rail**（`oklch(0.948 0.004 80)`；夜间 `oklch(0.2 0.006 75)`）：外壳与侧栏底色，浅色比工作区略深、深色比工作区略亮；导轨内文字就是 `--text` 三级（`--rail-text*` 是别名）。
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

- 外壳（docs/design/29）：左侧 248px 控制导轨（品牌 + 停靠管家 / 搜索 / 收起图标按钮；"Solo / 空间"两种模式：Solo 放新对话与会话、动态，空间放空间选择、主导航、最近需求；底部主题切换；⌘B 收为 60px 图标导轨）+ 右侧工作区面板（离窗口 8px、14px 圆角、自己滚动）；顶栏 52px 吸在面板顶部，含面包屑、数据来源标记、节拍指示、⌘K 按钮。
- 工作区内边距 24px / 32px；页面定高用 `--panel-h`，不用 `100vh`；窄于 900px 时面板铺满窗口、导轨收为抽屉（汉堡按钮打开、点遮罩或路由变化关闭），面包屑只留当前页。
- 间距：布局一律按 **8px 网格**（8 / 16 / 24 / 32 / 48 / 64，`--sp-2/4/6/8/12/16`）；4 / 12 / 20 只用于控件内部微调。同组元素 8px，组与组 16–24px，区块之间 24–32px。少套框，多用间距与色调分组。
- 表格行高 44px，导航行高 32px，命令面板行高 38px。

## Elevation & Depth

层次以色调分层为主、阴影为辅：暖纸底 → 纸面卡片 → 浮层。凸起面有一道 1px 的内高光（`--edge-light`），像机加工件的倒角；阴影低而利落，不做漫射光晕。

### Shadow Vocabulary
- **sm**（`inset 0 1px 0 var(--edge-light), 0 1px 2px var(--shadow-color), 0 0 0 1px var(--border)`）：卡片、按钮。
- **md**（`0 6px 18px -6px …, 0 2px 5px -2px …, 0 0 0 1px var(--border)`）：悬浮卡片、下拉。
- **lg**（`0 28px 60px -16px …, 0 10px 20px -10px …, 0 0 0 1px var(--border-strong)`）：命令面板、抽屉、窄屏导轨。

### 三层表面（M4）
| 层 | 底色 | 阴影 token | 用途 |
|---|---|---|---|
| 页面底 | `--bg` | 无 | 工作区背景 |
| 卡片 | `--surface` / `--surface-raised` | `--elev-1`（7% 描边环 + 1px 近影 + `0 8px 24px -14px` 低漫射；卡片不再叠 `border`） | 卡片、表格容器、读数格 |
| 浮层 | `--surface-overlay` | `--elev-2`（下拉、菜单、气泡）/ `--elev-3`（对话框、抽屉、停靠面板、⌘K、toast） | 浮在内容之上的一切 |

浅色主题靠细阴影区分层次；深色主题阴影几乎看不见，所以**浮层更亮（`--surface-overlay`）+ 描边更实（`--border-strong`）**。三个 `--elev-*` 都自带 1px 描边与顶部内高光，不要再叠 `border`。

### Named Rules
**The Flat At Rest Rule.** 静止的表面只用 elev-1；只有浮在内容之上的东西用 elev-2 / elev-3。

## Shapes

圆角刻度 **6 / 14 / 18**（`--r-sm` / `--r-md` / `--r-lg`；旧名 `--radius-sm` / `--radius` / `--radius-lg` 指向它们）：按钮、输入、标签、菜单项 6px，卡片、面板与读数格 14px，浮层（对话框、抽屉、⌘K、toast）18px；管家回答里的可视化块 12px；角标与行内代码 4px（`--radius-xs`），计数角标用胶囊。字号刻度 **12 / 13 / 14 / 16 / 20 / 28**（11px 只给分组标题与角标）。描边 1px，深浅主题都用半透明暖灰。不使用单侧粗色条；"当前位置"用 2–3px 的节拍刻度表达，只出现在导航与命令面板的选中行。

## Components

### Buttons
- **Shape:** `rounded.sm`（6px）圆角，高 30px（小号 26px）。
- **Primary:** 墨色底、反白文字、内高光；hover 变浅一级。
- **Default:** 纸面底 + strong 描边；hover 换 `--surface-hover`。
- **Press:** 所有按钮按下 `scale(.98)`，80ms（`--dur-press`）；非 `.btn` 的可点元素加 `.pressable`。
- **Ghost:** 无底无边，hover 才出现底色。
- **Focus:** 2px 节拍橙焦点环，偏移 2px，120ms 淡入（`--dur-focus`）。
- **强调色**（takt-orange）只用于两处：主动作的焦点 / 选中记号，以及实时状态（运行中、思考中、流式光标、未读角标）。

### Navigation（控制导轨）
- 导轨跟随主题；顶部"Solo / 空间"模式标签（文字 + 当前项下划线，收起时换图标）；条目 13px/500，图标 16px、描边 1.75。
- hover：`--rail-hover` 底，图标各做一次 300ms 的小动作（总览方块错位、需求下沉、待办弹一下、知识库翻开、Workflow 前推、评测晃瓶、设置拧半格；`data-motion`，减少动效时不动）；当前页：`--rail-active` 底 + 左缘 3px 节拍橙刻度 + 图标变橙，`aria-current="page"`。
- 待办数用节拍橙胶囊角标；其他计数用 rail-text-3 等宽数字。
- 底部：三段主题切换（跟随系统 / 浅色 / 深色）与版本号。

### 顶栏与面包屑
- 半透明暖纸底 + 模糊；面包屑是 `<ol>`，分隔用 chevron，当前页 500 字重。
- 下沿平时没有线；内容滚到顶栏下面时才出现 1px `--border` 分隔线（docs/design/30 §1，原来的刻度传送带已去掉）。
- 右侧：演示数据（虚线中性描边，不是告警）、节拍指示（"N 个需求在跑"，有运行时橙点按拍子跳）、⌘K 按钮。

### 命令面板（⌘K / Ctrl+K）
- 640px 宽、`rounded.lg`（18px，浮层）圆角、`--elev-3` 阴影，从顶部 12vh 处出现（200ms 淡入 + 6px 下落，150ms 退出）。
- 分组：页面 / 查询 / 命令 / 需求 / 运行 / 操作（主题切换）；多词全命中过滤，标识前缀命中排前，分组按组内最佳匹配排序。
- 查询 / 命令来自 `/api/commands`：风险用图标（只读 眼睛 / 写入 笔 / 危险 盾牌，危险用失败色）；选中后进入按 input schema 生成的表单，需求 / 运行 / 节点从当前页面自动带入（标"来自当前页面"）；write / dangerous 必须写原因；⌘↵ 执行，Esc 返回列表。别的界面用 `openCommand(id, input)` 直接打开某条命令。
- 选中行：hover 底 + 左缘 2px 节拍橙刻度 + 回车图标；↑↓ 选择、↵ 打开、Esc 关闭，关闭后焦点回到触发处。

### 节拍尺（Signature）
- 一排 2px 刻度，每 4 格一根长刻度。
- **运行中**：光点按拍子逐格点亮（传送带）；只出现在真的有东西在进行的地方（群聊 Lead 思考中、任务卡运行中）。
- **加载**（`TaktLoader`）：节拍尺快拍（110ms 一格）+ 一句说明在等什么；120ms 后才淡入，快速返回不闪。
- 不当装饰：空状态下面、顶栏下沿都不画节拍尺（docs/design/30 §1）。

### Cards / Containers
- `rounded.md`（14px）圆角、纸面底、`--elev-1` 阴影（无描边）；卡片头 48px、左右 20px，标题 14px/600。

### 可视化组件（M4.5，`components/viz/`，规则见 docs/design/24）
- **读数格** `StatTiles`：小标签 + 大数字（只在表达状态且非 0 时着色）+ 一行注释；列数按**容器**宽度（≥860 全部一行 / ≥520 ceil(n/2) / ≥300 至多 3 / 更窄 2），最后一行自动撑满，不留孤格。
- **泳道** `LaneTrack`：一格一阶段，完成实色、运行中实色并按 `--takt` 闪拍、等人斜纹、失败红、未开始空心；当前格高一截。总览"交付泳道"、需求表阶段列、管家 lanes 块共用。
- **阶段轨道** `StageRail`（`components/stage-rail.tsx`，需求页头部、运行页头部；docs/design/25 §6）：一条轨道串起各阶段站点。已完成的段实色绿，当前阶段从站点往下一站伸出"本阶段完成比例"那么长的传送带段，头上一颗节拍橙光点；没走到的段是虚线。站点：完成绿底白勾、进行中蓝环 + 节拍点 + 外环、等人琥珀暂停、失败红叉、未开始虚线圈 + 序号；当前站放大一档。站点下是阶段名、节点刻度（一节点一格，超过 12 个改细条）、计数，当前阶段再加一句"在跑：<节点>"。站点可点（需求页 → 运行页定位，运行页 → 画布聚焦）。
- **条形 / 清单 / 时间线** `Bars` / `Checklist` / `Timeline`：条形用 `clip-path` 从左打开（圆角不变形），读数在条形长到大半后再淡入；清单顶部一条完成度；时间线圆点 + 细线、最新在上。
- **迷你趋势** `Sparkline` / `RunBars`（M4.6）：读数格右上角的 14 天折线（与标签同一行，格子太窄就不画）；需求行 Token 旁最近 12 次运行的迷你柱，高 = Token、色 = 结果，任务运行更淡。
- **管家可视化块** `StewardBlocks`：stats / lanes / bars / table / checklist / timeline / callout / actions，最多 6 块；按钮只追问、跳转或打开预填命令表单，从不直接写。

### 动作行与 Agent 形象（M4.6，docs/design/25）
- **动作行** `ActionText` / `ActionRow`（`components/action-row.tsx`，动词表在 `lib/actions.ts`）：工具调用写成"动词 + 对象 + 结果"（读取 / 搜索 / 修改 / 运行 / 访问 / 检索 / 派给 / 调用），动词加粗、路径等宽、`+A −D` 红绿、`通过 / 失败` 着色；连续同动词合并 `×N`，失败的不合并。管家动作清单、运行页滚动条、节点"过程"共用。
- **Agent 形象** `AgentMark`（`components/agent-mark.tsx`）：节拍蜂（docs/design/27、30 §1）。**角色定道具**（`role` → `lib/roles.ts`：产品便签、架构尺子、开发扳手、测试试管、评审放大镜、判决法槌、规划信封、Lead 指挥棒、管家铃铛），< 40px 画成右下角的道具角标，≥ 40px 拿在手里；**harness 定身体色**（`harnessHue`，同一家的 CLI 与 ACP 同色，琥珀 `--c-4` 不分给 harness，免得和管家的蜂蜜色混）。状态：待命、干活（按动作换表情 / 手上工具）、求助（`!`/`?` 角标）、完成、失败。**不使用任何第三方品牌图形。**

### Inputs
- `rounded.sm`（6px）圆角、strong 描边；focus 时描边变节拍橙 + 3px 柔和外环。

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
| Tab | 指示器 transform 平移，内容淡入 150ms；点 Tab 切换时顺着方向滑入 10px、200ms | `<Tabs>` + `<TabPanel key={tab}>` |
| 列表首屏 | 每项间隔 24ms、最多 10 项、单项 160ms；之后的更新不入场 | `useStagger(n)` |
| 新行 | 底色闪一下，1.2s 淡出 | `useFlashRows(keys)` → `.flash-row` |
| 数字 | 旧值 → 新值 400ms，等宽数字；首屏从 0 只给总览 | `<CountUp value from0 />` |
| 运行中 / 思考中 / 流式 / 展开 | 节拍呼吸外环 / 扫光 / 光标闪烁 / `grid-template-rows: 0fr → 1fr` | `.live-ring` / `.shimmer-text` / `.stream-caret` / `.expand[data-open]` |
| 抽屉 / 停靠面板 | 右侧 `translateX(16px)` + 淡入 220ms，退出 160ms；停靠面板在 ≥1280px 时把工作区让出 440px（宽度变化不做过渡），窄屏浮在页面上 | `<Drawer>`（`mode` 取 `modal` 或 `dock`）；`.shell[data-dock='open']` |
| 快捷键 | ⌘J 管家、⌘K 命令面板、C 新建需求（不在输入框时）、⌘B 收起侧栏；写进按钮 tooltip | `lib/shortcuts`、`<Kbd combo />`、`withShortcut()` |

### M4.5 可视化与动效（docs/design/24）
| 场景 | 规格 |
|---|---|
| 字数 | 页面说明 ≤ 24 字（只放状态读数，如"3 项等你决定 · 2 条风险"）；管家建议 ≤ 14 字、不重复对象名；管家正文 ≤ 3 句，数字交给块 |
| 布局 | 组件按容器宽度（`container-type: inline-size`）变形，不按视口；停靠面板打开时同一组件自动换成窄布局，任何宽度都不出现"一字一行" |
| 读数格入场 | 每格间隔 40ms 上浮 4px |
| 泳道入场 | 每格 `clip-path` 从左打开，260ms，间隔 18ms（最多 12 格） |
| 条形 | `clip-path` 从左打开，520ms，间隔 40ms；读数 +360ms 后淡入 160ms（M4.6） |
| 清单完成度 | `scaleX` 0→值，520ms |
| 管家块组装 | 正文之后逐块送达，每块上浮 4px + 淡入 220ms，间隔 60ms |
| 欢迎页 | 问候 + 日期，三格空间读数（点了直接问），短建议胶囊（间隔 40ms 入场），最近会话同名只留最新 |

reduced-motion：以上入场全部去掉位移、只留透明度；运行中格子的闪拍静止为一层 25% 高光。

### M4.6 运行态与回访（docs/design/25）
| 场景 | 规格 |
|---|---|
| 隐藏即停 | 标签页在后台时根元素带 `data-tab-hidden`，所有动画 `animation-play-state: paused`，回来接着走 |
| 到达规则 | 首屏已有的内容随容器一起出现（错峰一次）；之后到达的才单独入场；轮询刷新不重播 |
| Agent 形象 | 干活：每 4 拍眨眼、随节拍起伏 0.6px；求助：符号每 2 拍轻跳 2px；其余状态静止；reduced-motion 全部静止 |
| 迷你趋势 | 折线首次描线 400ms，末点 +360ms 淡入；运行中的柱子按节拍明暗；数据更新直接换形 |
| 动作行 | 新动作上移 3px 淡入 160ms；进行中那行图标节拍光环、文字扫光；滚动条里并入同一行时只是 ×N 加一 |
| 回访 | 标签页标题 `(n) taktflow 控制台`；图标右上角状态点（等你琥珀优先、运行中节拍橙）；运行结束 / 新的等你决定弹卡片（9s，带两个去处），后台且开了通知时发系统通知 |

### 阶段轨道与页面层次（docs/design/25 §6）
| 场景 | 规格 |
|---|---|
| 阶段轨道入场 | 完成段 `clip-path` 从左铺开 700ms；轨道走到哪站，那站弹亮（380ms 弹簧）、勾描出来 300ms；站点上移 4px 淡入、间隔 40ms；当前段在铺完后伸出 420ms，光点 +200ms 冒出 |
| 阶段推进 | 轨道与光点 700ms 过渡到新位置；新的当前站在轨道到达时才点亮，之后外环按 `--takt` 外扩；站点图形换状态时缩放淡入 220ms；入场播完后再完成的站立刻点亮 |
| 运行中 | 当前段的传送带接缝每拍前进一格；站点节拍点每拍跳一下；当前节点刻度按拍明暗；等人外环两拍一次；失败静止 |
| 全部完成 | 一道光沿轨道扫过 900ms，站点依次轻跳（间隔 70ms），最后一站放一圈光；只在挂载时播一次 |
| 页面分层入场 | `.page` / `.cascade` 的直接子块上移 4px 淡入 260ms，45ms 一层（最多 6 层）；特异度为 0，子块自带动画时以它为准；Tab 内容不参与 |
| 当前项滑块 | 侧栏导航、产物列表的选中底色（侧栏连同左缘节拍刻度）用一个滑块 `translateY` 滑过去 220ms，高度直接设定 |
| 产物切换 | 换产物：页头 → 元信息 → 正文依次上移淡入（40ms 一层）；只换版本时只有正文重来 |
| 进度条 | `.meter` 首次出现 `clip-path` 从左打开 520ms（+120ms），之后数值变化走 `scaleX` 过渡 |

reduced-motion：轨道直接显示终态（无铺开、无外环、无传送带），分层入场与滑块去掉，Tab 只淡入。

新增时长 token：`--dur-route-out` 120 / `--dur-route-in` 200 / `--dur-tab` 150 / `--dur-item` 160 / `--stagger-step` 24 / `--dur-count` 400 / `--dur-flash` 1200 / `--dur-dock` 220 / `--dur-focus` 120 / `--skeleton-delay` 120（ms）；曲线 `--ease-out-soft: cubic-bezier(.2,.8,.2,1)`。reduced-motion 下这些都只保留透明度（`styles/motion.css` 用 `!important` 压过全局兜底），无限动画静止但可见。

### M5 运行透明与归因可信度（docs/design/21、26）
| 场景 | 规格 |
|---|---|
| 时间视图 | 泳道按阶段分组；段落 run 运行色、wait 等待色、queue 浅灰条纹、tool 细段、compact 菱形。入场：段落 `clip-path` 从左打开 620ms，行间隔 24ms；压缩点弹出 320ms（+420ms）；上下文曲线描线 900ms（+240ms），80% 以上的琥珀区间与压缩竖线 +900ms 淡入。进行中的段按 `--takt` 走传送带 |
| 改动卡 | 节点抽屉概览显示前 3 行，"改动" tab 显示全部；仓库与存放区分组，五格 diffstat（绿增红删灰不变）；没有回退点时回退按钮置灰并写明原因 |
| 时限条 | 等人待办一条细进度条，刻度在"提醒"与"再提醒（含负责人）"；接近交还变琥珀，刻度每 2 拍明暗一次；approve / choice 超时不交还，同样琥珀并写"不会自动通过"；已交还显示交还时间和按的假设 |
| 回执站点 | 任务：已发出 → 已接手 → 已开始 → 完成；转达：已发出 → 已接手 → 已回复。站点上移淡入、间隔 70ms，当前站外环每 2 拍外扩；拒绝 / 不确定 / 过期作为末端标签，不画成站点；跳数链超过 5 跳折叠 |
| 门禁三态 | 通过：绿底勾；不通过：红底叉；检查出错：中性字色 + 琥珀虚线框——是流程问题不是产物缺陷，不能和"不通过"混 |
| 漏检五条件 | 每格成立（勾）/ 不成立（叉）/ 无法判断（问号虚线），表头写条件名，不在格子里重复编号；人工结论带"人工"标记 |
| 回放报告 | 门槛结论或"探索性"放在报告顶部，左缘细线按结论着色（达标绿 / 不达标红 / 探索琥珀），旁附门槛快照。通过率用区间条：0–100% 轨道、Wilson 区间为带、点估计为点；基线灰、候选强调色；带从左展开、点弹出。逐次结论用点：通过实心绿、失败实心红、证据不足空心斜纹（不算通过）、误报菱形 |
| 拒绝启动 | 琥珀卡：编号列出每条原因，下面一行箭头写下一步；明确"没有回放、没有消耗 token" |
| 质量日志 | 链完整：绿；锚点落后：琥珀 + "修复锚点"（填原因）；链被篡改：红色警告 + 处理步骤，**不给修复按钮**，图标外环慢速提示 |

reduced-motion：泳道、曲线、区间带直接显示终态；回执当前站外环、时限刻度、质量日志告警外环静止但可见。

### M6 DAG 动效与运行时配置（docs/design/27 §2、§4）
| 场景 | 规格 |
|---|---|
| DAG 首次出现 | 每条边叠一层 `pathLength=1` 的描线（`edge-sweep`），延迟按源节点 x 坐标折算（入口 0 → 出口 ≤ 1.1s），单条 620ms；打回边比同层晚 240ms 反向描 |
| 运行中 | 通往在跑节点的边走传送带（`--takt` 一拍一格）+ 流动的信号点；在跑节点外环随拍呼吸 |
| 节点完成 | 一颗信号点（`edge-comet`）沿每条出边送到下游，约 600ms；首屏已完成的节点不播 |
| 悬停 / 选中 | 只亮一跳（直接上下游）：相关边加粗并流动，其余边降到 22%、节点降到 42%（选中但未悬停时边 50%） |
| 回放 | 已结束的运行在工具栏给"回放"：按真实开始 / 结束时间压到 6 秒重演，节点 等待（32% 去饱和）→ 在跑（外环半拍呼吸）→ 完成（一次性落定），边在目标节点开始时送一颗信号；镜头跟随在跑节点所在阶段；按钮下沿是进度条，可中途停 |
| Workflow 编辑器 | 首屏描线（延迟按源 x 折算）；悬停 / 选中节点时它的边走传送带，打回反向 |
| 设置「模型与 Harness」 | 卡片与行逐项入场、新增的行闪一下；测试结果从上方 4px 展开（320ms）；测试中图标按一拍旋转；预设卡片悬停上抬 1px；开关旋钮用弹簧曲线 |

reduced-motion：边不描线、不流动，在跑的边用实色；回放仍能切换节点状态（只有类名变化，没有过渡）。

### 节拍蜂（docs/design/27 §1）
| 场景 | 规格 |
|---|---|
| 组件 | `Bee`（`components/mascot`）：`state` 8 选 1、`size`（≤ 24 tiny 只留轮廓条纹眼睛并裁紧 viewBox，≤ 40 small 线条加粗）、`hue`（品牌蜂蜂蜜色，Agent 按 harness）、`prop` / `tools`、`logo`、`calm`（关基础循环，只播入场动作）、`still`（全静止）、`interactive`（可戳） |
| 基础循环 | 都按 `--takt` 的整数倍：待命悬停 2 拍 + 翅膀 2 拍一阵；干活每拍上下 + 扇 4 下；完成每拍弹一下；睡着 3 拍深呼吸 |
| 小动作 | 状态切换时先播入场动作；之后间隔 0.8–5 秒洗牌挑一个，动作结束回原位；关键帧都以 `bee-` 开头 |
| 克制 | 品牌标 5 个轻量动作、间隔 ×1.8；DAG 只有在跑 / 等人的节点挑动作；管家历史头像静止；后台 / 视口外不挑动作 |
| 减少动态效果 | 循环、动作、姿势过渡全停，只留每个状态的静态表情 |

## 组件清单（docs/design/30 §1）

组件库就是 `packages/web/src/components/ui/`（加 `components/ui.tsx`、`agent-mark.tsx`、`identity.tsx`）。**新页面只用这里有的写法；没有的，先补进组件库、放上 `/ui` 陈列页，再在页面里用。** 打开 `/ui`（⌘K 搜"组件"）能看到每个组件的实际样子。

| 要表达的东西 | 只用 | 不要 |
|---|---|---|
| 人 | `Avatar`（首字母实色圆，16 / 20 / 24 / 32 四档，传 `id` 定颜色）、`AvatarStack` | 自己画圆 + 字母、淡色底 |
| Agent / 子 Agent | `AgentMark`（`role` + `hue={harnessHue(h)}`） | lucide `Bot`、统一的机器人 / 方块图标 |
| 管家 / Lead | `StewardMark` / `LeadMark` | `✦`、lucide `Sparkles`、深色方块里的星号 |
| 按钮 / 菜单里的"管家" | `BeeGlyph`（lucide 同规格线稿） | 彩色的蜂塞进按钮 |
| 节点类型、系统事件 | `KindIcon` / lucide 线稿 | — |
| 状态 | `StatusBadge` / `StatusDot`（`--st-*`） | 自己写颜色的小圆点、胶囊 |
| 空 / 错误 | `EmptyState`（`compact` 用 48px 蜂）/ `ErrorState` | 灰框图标、页面里自己写 `empty-state` 类名 |
| 加载 | `Skeleton*`；整页首屏 `TaktLoader` | "加载中…"文案、空态下的节拍尺 |
| 选择 / 标签 / Tab | `Segmented`、`Chip(s)`、`Tabs` + `TabPanel`、`Menu`、`Popover` | 自写 radio 组、下拉 |
| 多选 / 自由输入 / 开关 | `ToggleChips`（技能、知识库、渠道；引用了但不存在的画成虚线红框）、`TagInput`（glob、需求 id，回车添加）、`Switch`（立即生效的启用 / 停用） | 一排 checkbox、逗号分隔的文本框、自画开关 |
| 浮层 | `Dialog`、`Drawer`、`ReasonDialog`（写操作要原因） | 自写遮罩 |
| 悬停看详情 | `HoverCard` + `useHoverCard`（400ms 后出现，贴在锚点右侧；只放补充信息，操作仍在 ⋯ 菜单里） | `title` 属性塞长文、自写定位浮层 |
| 菜单项带说明 | `Menu` 的 `description`（例如不可用的原因，会换行）；当前项用 `checked` | 把原因塞进 `hint` 被截断 |
| 颜色 | `tokens.css` 的变量（`--c-1..8`、`--st-*`、`--accent`…） | 有彩色的裸色值（黑 / 白 / 灰做遮罩阴影可以） |

`npm run ux:audit -w @taktflow/web` 拦这些写法（CI 必过）：`identity-icon`（引 lucide 的 Bot / Sparkles）、`adhoc-empty`（自己拼空态）、`raw-color`（CSS 里的有彩色裸色值），以及原有的 `loading-text`、`async-empty`、`cli-hint`。确有理由时在该行或上一行写 `ux-audit: ok <原因>`。

## Iconography

lucide-react，线性图标；导航 16px / 描边 1.75，正文与按钮 14px，徽章 12px。图标只做识别，不做装饰；状态图标与状态色成对出现。"管家"在按钮、菜单、标签里用 `BeeGlyph`（圆身、两道纹、带圆点的触角，和 lucide 同为 24 网格 2px 描边）；lucide 的 `Bot`、`Sparkles` 不表示任何东西的身份。

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
