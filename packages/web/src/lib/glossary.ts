/**
 * 术语表（TF-041 / TF-074）：界面上的核心概念统一用这里的中文叫法，并给一句话解释（悬停说明、<Term>、节点类型提示共用）。
 * en 是配置文件 / API 里的英文名：用户可见文案只用中文名，英文名只出现在说明里，避免"流水线"和"workflow"、"职责"和"duties"混着用。
 * Harness、Lead、Agent 没有通行的中文译名，保留英文，统一大小写。
 */
export interface GlossaryEntry {
  /** 配置文件 / API 里的英文名。 */
  en?: string
  /** 一句话解释：是什么、为什么要关心。 */
  hint: string
}

export const GLOSSARY = {
  空间: { en: 'space', hint: '一个团队或项目的工作区：需求、流水线、成员和设置都按空间隔开' },
  需求: { en: 'requirement', hint: '要交付的一件事；系统按流水线把它从输入一路跑到交付' },
  流水线: { en: 'workflow', hint: '需求从输入到交付要走的步骤图：分阶段，每个阶段由若干节点组成' },
  节点: { en: 'node', hint: '流水线里的一步，可以是 Agent、脚本、门禁、评审或人工确认' },
  运行: { en: 'run', hint: '按流水线把一个需求执行一遍；同一个需求可以有多次运行' },
  待办: { en: 'attention', hint: '流水线停下来等人处理的事：审批、回答澄清问题、门禁裁决' },
  进行中: { en: 'active', hint: '已经开始、还没交付的需求（不一定有节点在跑）' },
  在跑: { en: 'running', hint: '此刻有节点正在执行' },
  草稿: { en: 'draft', hint: '还没开始跑的需求，补全后再启动' },
  门禁: { en: 'gate', hint: '自动检查，不通过就不往下走' },
  判决: { en: 'judge / verdict', hint: '测试失败后由独立的 Agent 判断原因：产品缺陷、脚本问题、用例问题还是环境问题' },
  评审: { en: 'review', hint: '由 Agent 或人检查产物并提出问题，问题处置完才算通过' },
  脚本: { en: 'script', hint: '直接执行的命令或测试脚本，不经过大模型' },
  人工: { en: 'human', hint: '需要人来确认或回答的一步，会出现在待办里' },
  循环: { en: 'loop', hint: '反复执行一组节点（例如开发 → 测试），直到通过或达到次数上限' },
  规划: { en: 'planner', hint: '由 Agent 按需求临时展开后续节点' },
  子流程: { en: 'subflow', hint: '在一个节点里嵌套执行另一条流水线' },
  Agent: { en: 'agent', hint: '由大模型驱动、通过 Harness 执行的一步' },
  Lead: { en: 'lead', hint: '每个需求的协调 Agent：拆任务、派给各角色，在需求群里汇报进度' },
  Harness: { en: 'harness', hint: '实际执行 Agent 的工具，例如 Claude Code、Codex；在空间设置的“模型与 Harness”里配置' },
  管家: { en: 'steward', hint: '跨空间的助手：问进度、查原因、让它代办；改动前会先给出提案等你确认' },
  职责: { en: 'duties', hint: '成员负责的事项标签；待办会自动派给职责里含这个标签的成员' },
  档位: { en: 'tier', hint: '按改动形状决定流程繁简：T0 已写死、T1 单一改动面、T2 多面串行、T3 多面并行' },
  已校验: { en: 'verified', hint: '通过的门禁检查（含交付校验）与通过的评审轮次' },
  拦截: { en: 'intercepted', hint: '交付前被门禁、评审、判决或完成标准挡下的问题' },
  失败指纹: { en: 'failure fingerprint', hint: '同一节点、同一失败原因、同一输入的签名；同一指纹第二次出现就停止重试，避免空转' },
  演示数据: { en: 'mock', hint: '内置的示例空间和需求，不是你的 takt serve 数据' },
} satisfies Record<string, GlossaryEntry>

export type Term = keyof typeof GLOSSARY

/** 悬停说明：“门禁：自动检查，不通过就不往下走”。 */
export const termTitle = (term: Term): string => `${term}：${GLOSSARY[term].hint}`
