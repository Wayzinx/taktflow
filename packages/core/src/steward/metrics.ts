import type { ProductEvent, ProductMetric, StewardMessage } from '../api.js'
import type { StewardDeps } from './contracts.js'
import { StewardError, timestamp } from './contracts.js'
import { StewardStore } from './store.js'

export interface MetricRow {
  at: string
  feature: string
  type: string
  ms?: number
  value?: number
  tools?: number
  errors?: number
  coverage?: number
  rating?: string
  reason?: string
  edited?: boolean
  commands?: string[]
  detail?: Record<string, unknown>
}
export function citationCoverage(text: string): number {
  const normalized = text.replace(/([。！？.!?])\s*((?:\[\d+\])+)/g, '$2$1')
  const facts = normalized
    .split(/[。！？\n]|(?<=[.!?])\s+/u)
    .filter((sentence) =>
      /\d|完成|失败|运行|阻塞|等待|待办|交付|风险|进度|draft|active|running|failed|blocked|delivered|pending|succeeded/i.test(
        sentence.replace(/\[\d+\]/g, ''),
      ),
    )
  return facts.length
    ? facts.filter((sentence) => /\[\d+\]/.test(sentence)).length / facts.length
    : 1
}
export async function recordAnswer(
  deps: StewardDeps,
  store: StewardStore,
  message: StewardMessage,
  latencyMs: number,
): Promise<void> {
  await store.append('metrics.jsonl', {
    at: timestamp(deps),
    feature: 'steward.answer',
    type: 'answer',
    ms: latencyMs,
    tools: message.tools?.length ?? 0,
    errors: message.tools?.filter((tool) => !tool.ok).length ?? 0,
    coverage: citationCoverage(message.text),
  })
}
export async function recordProductEvent(
  deps: StewardDeps,
  store: StewardStore,
  event: ProductEvent,
): Promise<void> {
  if (
    ![
      'dialog.open',
      'dialog.submit',
      'dialog.cancel',
      'suggestion.click',
      'digest.open',
      'digest.click',
      'risk.action',
      'palette.ask',
    ].includes(event.type) ||
    typeof event.feature !== 'string' ||
    !event.feature.trim() ||
    (event.ms !== undefined && (!Number.isFinite(event.ms) || event.ms < 0)) ||
    (event.detail &&
      (typeof event.detail !== 'object' ||
        Array.isArray(event.detail) ||
        Object.values(event.detail).some(
          (v) => !['string', 'number', 'boolean'].includes(typeof v),
        )))
  )
    throw new StewardError(400, '交互事件格式错误，请检查类型、功能和耗时')
  await store.append('metrics.jsonl', { ...event, at: timestamp(deps) })
}
export async function productMetrics(
  deps: StewardDeps,
  store: StewardStore,
): Promise<ProductMetric[]> {
  const now = deps.now?.() ?? new Date(),
    day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const start = new Date(day)
  start.setDate(start.getDate() - 6)
  const rows = (await store.lines<MetricRow>('metrics.jsonl')).filter(
    (row) => Date.parse(row.at) >= start.getTime() && Date.parse(row.at) <= now.getTime(),
  )
  for (const summary of await deps.spaces()) {
    const { stores } = await deps.open(summary.id),
      requirements = await stores.workspaces.listRequirements(),
      runs = await stores.runs.list()
    for (const req of requirements) {
      if (Date.parse(req.createdAt) < start.getTime() || Date.parse(req.createdAt) > now.getTime())
        continue
      const first = runs
        .filter((run) => run.requirementId === req.id)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]
      rows.push({
        at: req.createdAt,
        feature: 'requirement.create',
        type: 'created',
        value: first && Date.parse(first.startedAt) - Date.parse(req.createdAt) <= 300000 ? 1 : 0,
      })
    }
    for (const run of runs)
      for (const event of await stores.events.read(run.runId)) {
        if (Date.parse(event.ts) < start.getTime() || Date.parse(event.ts) > now.getTime()) continue
        const data = event.data as unknown as Record<string, unknown>
        if (event.type === 'route.decided')
          rows.push({
            at: event.ts,
            feature: 'requirement.create',
            type: 'route',
            value: data.overridden ? 1 : 0,
          })
        if (event.type === 'knowledge.query')
          rows.push({
            at: event.ts,
            feature: 'knowledge',
            type: 'query',
            ms: Number(data.latencyMs ?? 0),
            value: Number(data.hits) > 0 ? 1 : 0,
          })
        if (event.type === 'knowledge.used')
          rows.push({ at: event.ts, feature: 'knowledge', type: 'used' })
      }
    if (stores.kb)
      for (const base of await stores.kb.list())
        for (const evaluation of await stores.kb.evalRuns(base.id)) {
          const at = evaluation.endedAt ?? evaluation.startedAt
          if (
            evaluation.status !== 'done' ||
            Date.parse(at) < start.getTime() ||
            Date.parse(at) > now.getTime()
          )
            continue
          for (const metrics of Object.values(evaluation.metrics))
            rows.push({
              at,
              feature: 'knowledge',
              type: 'recall',
              value: metrics.recall10,
              detail: { n: metrics.n },
            })
        }
  }
  const output: ProductMetric[] = []
  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const add = (
    feature: string,
    metric: string,
    unit: string,
    hint: string,
    select: (row: MetricRow) => boolean,
    calculate: (rows: MetricRow[]) => number,
    samples: (rows: MetricRow[]) => number = (rs) => rs.length,
  ) => {
    const selected = rows.filter((row) => row.feature === feature && select(row))
    const trend = Array.from({ length: 7 }, (_, i) => {
      const from = new Date(start)
      from.setDate(from.getDate() + i)
      const to = new Date(from)
      to.setDate(to.getDate() + 1)
      return calculate(
        selected.filter(
          (r) => Date.parse(r.at) >= from.getTime() && Date.parse(r.at) < to.getTime(),
        ),
      )
    })
    output.push({
      feature,
      metric,
      value: calculate(selected),
      unit,
      window: '7d',
      trend,
      hint: selected.length ? hint : `暂无样本；${hint}`,
      samples: samples(selected),
    })
  }
  for (const feature of ['requirement.create', 'workflow.edit', 'space.create', 'knowledge']) {
    add(
      feature,
      'completion_ms',
      'ms',
      '耗时增加时检查表单与操作路径',
      (r) => r.type === 'dialog.submit',
      (rs) => mean(rs.map((r) => r.ms ?? 0)),
    )
    // 新建需求的提交数按真正建出来的需求算（对话框、管家、CLI 都算），和「5 分钟内开始运行」同一个分母
    add(
      feature,
      'submissions',
      'count',
      '结合打开次数检查创建流程流失',
      (r) => (feature === 'requirement.create' ? r.type === 'created' : r.type === 'dialog.submit'),
      (rs) => rs.length,
    )
    add(
      feature,
      'submit_rate',
      '%',
      '提交比例偏低时缩短操作路径',
      (r) => ['dialog.open', 'dialog.submit'].includes(r.type),
      (rs) =>
        (rs.filter((r) => r.type === 'dialog.submit').length /
          Math.max(1, rs.filter((r) => r.type === 'dialog.open').length)) *
        100,
      (rs) => rs.filter((r) => r.type === 'dialog.open').length,
    )
  }
  add(
    'requirement.create',
    'started_within_5m',
    '%',
    '启动比例偏低时检查路由与输入提示',
    (r) => r.type === 'created',
    (rs) => mean(rs.map((r) => r.value ?? 0)) * 100,
  )
  add(
    'requirement.create',
    'route_override',
    '%',
    '人工改路由较多时调整路由规则',
    (r) => r.type === 'route',
    (rs) => mean(rs.map((r) => r.value ?? 0)) * 100,
  )
  add(
    'requirement.create',
    'criteria_adopted',
    '%',
    '验收标准建议采纳较少时调整提示词',
    (r) => r.detail?.criteriaSuggested === true,
    (rs) => mean(rs.map((r) => (r.detail?.criteriaAdopted === true ? 1 : 0))) * 100,
  )
  for (const [metric, field, unit, hint] of [
    ['first_token_ms', 'ms', 'ms', '首字延迟增加时检查模型和工具耗时'],
    ['tools_avg', 'tools', 'count', '工具调用较多时改善工具摘要'],
    ['citation_coverage', 'coverage', '%', '引用覆盖不足时修正提示词和事实来源'],
  ] as const) {
    add(
      'steward.answer',
      metric,
      unit,
      hint,
      (r) => r.type === 'answer',
      (rs) => mean(rs.map((r) => Number(r[field] ?? 0))) * (unit === '%' ? 100 : 1),
    )
  }
  add(
    'steward.answer',
    'tool_error_rate',
    '%',
    '工具错误较多时检查参数和权限',
    (r) => r.type === 'answer',
    (rs) =>
      (rs.reduce((n, r) => n + (r.errors ?? 0), 0) /
        Math.max(
          1,
          rs.reduce((n, r) => n + (r.tools ?? 0), 0),
        )) *
      100,
  )
  add(
    'steward.answer',
    'down_rate',
    '%',
    '按负反馈原因调整问题理解与回答长度',
    (r) => r.type === 'feedback',
    (rs) => mean(rs.map((r) => (r.rating === 'down' ? 1 : 0))) * 100,
  )
  for (const reason of ['wrong', 'missed', 'verbose', 'bad_action'])
    add(
      'steward.answer',
      `down_${reason}`,
      'count',
      '查看相同原因的反馈并补充评测用例',
      (r) => r.type === 'feedback' && r.reason === reason,
      (rs) => rs.length,
    )
  const proposalRows = (r: MetricRow) =>
    ['applied', 'rejected', 'failed', 'reverted'].includes(r.type)
  for (const outcome of ['applied', 'edited', 'rejected', 'failed', 'reverted']) {
    const calc = (rs: MetricRow[]) => {
      const denominator = rs.filter((r) =>
        outcome === 'reverted'
          ? r.type === 'applied'
          : outcome === 'failed'
            ? ['applied', 'failed'].includes(r.type)
            : ['applied', 'failed', 'rejected'].includes(r.type),
      ).length
      const numerator = rs.filter((r) =>
        outcome === 'edited' ? r.edited && r.type === 'applied' : r.type === outcome,
      ).length
      return denominator ? (numerator / denominator) * 100 : 0
    }
    add(
      'steward.proposal',
      `${outcome}_rate`,
      '%',
      '按命令类型调整提案模板和信任档位',
      proposalRows,
      calc,
    )
    for (const command of new Set(rows.flatMap((r) => r.commands ?? [])))
      add(
        'steward.proposal',
        `${command}.${outcome}_rate`,
        '%',
        '检查该命令的提案参数与风险说明',
        (r) => proposalRows(r) && !!r.commands?.includes(command),
        calc,
      )
  }
  add('steward.proposal', 'decision_ms', 'ms', '决定耗时过长时改善提案预览', proposalRows, (rs) =>
    mean(rs.map((r) => r.ms ?? 0)),
  )
  add(
    'steward.digest',
    'click_rate',
    '%',
    '点击率低时调整汇报时间与摘要',
    (r) => ['digest.open', 'digest.click'].includes(r.type),
    (rs) =>
      (rs.filter((r) => r.type === 'digest.click').length /
        Math.max(1, rs.filter((r) => r.type === 'digest.open').length)) *
      100,
  )
  for (const type of ['snoozed', 'ignored'])
    add(
      'steward.digest',
      `${type}_rate`,
      '%',
      '持续忽略时建议调整提醒阈值',
      (r) => ['open', 'snoozed', 'ignored', 'risk.action'].includes(r.type),
      (rs) => mean(rs.map((r) => (r.type === type ? 1 : 0))) * 100,
    )
  add(
    'steward.digest',
    'resolution_ms',
    'ms',
    '风险处理耗时增加时优化建议动作',
    (r) => r.type === 'risk.resolved',
    (rs) => mean(rs.map((r) => r.ms ?? 0)),
  )
  for (const kind of new Set(
    rows
      .filter((r) => r.feature === 'steward.digest')
      .map((r) => r.detail?.kind)
      .filter((kind): kind is string => typeof kind === 'string'),
  )) {
    add(
      'steward.digest',
      `${kind}.resolution_rate`,
      '%',
      '提醒后处理比例低时调整该类风险阈值',
      (r) => r.detail?.kind === kind,
      (rs) => {
        const notified = new Set(
          rs.filter((r) => r.type === 'risk.notified').map((r) => r.detail?.key),
        )
        const resolved = new Set(
          rs
            .filter((r) => r.type === 'risk.resolved' && notified.has(r.detail?.key))
            .map((r) => r.detail?.key),
        )
        return notified.size ? (resolved.size / notified.size) * 100 : 0
      },
    )
  }
  add(
    'workflow.edit',
    'lint_error_rate',
    '%',
    '保存后 lint 失败时检查画布操作和源码转换',
    (r) => r.type === 'dialog.submit',
    (rs) => mean(rs.map((r) => (r.detail?.lintError ? 1 : 0))) * 100,
  )
  add(
    'workflow.edit',
    'conflict_rate',
    '%',
    '冲突较多时缩小提案范围并刷新基线',
    (r) => r.type === 'dialog.submit',
    (rs) => mean(rs.map((r) => (r.detail?.conflict ? 1 : 0))) * 100,
  )
  for (const template of ['blank', 'standard', 'quick'])
    add(
      'space.create',
      `template_${template}`,
      '%',
      '根据模板选择比例调整起点内容',
      (r) => r.type === 'dialog.submit',
      (rs) => mean(rs.map((r) => (r.detail?.template === template ? 1 : 0))) * 100,
    )
  add(
    'space.create',
    'first_requirement_ms',
    'ms',
    '首个需求耗时增加时优化空间引导',
    (r) => r.detail?.firstRequirementMs !== undefined,
    (rs) => mean(rs.map((r) => Number(r.detail?.firstRequirementMs))),
  )
  add(
    'knowledge',
    'hit_rate',
    '%',
    '无结果较多时补充文档或调整检索参数',
    (r) => r.type === 'query',
    (rs) => mean(rs.map((r) => r.value ?? 0)) * 100,
  )
  add(
    'knowledge',
    'recall10',
    '%',
    '召回率降低时调整切块、检索参数或补充文档',
    (r) => r.type === 'recall',
    (rs) => {
      const count = rs.reduce((sum, r) => sum + Number(r.detail?.n ?? 0), 0)
      return count
        ? (rs.reduce((sum, r) => sum + (r.value ?? 0) * Number(r.detail?.n ?? 0), 0) / count) * 100
        : 0
    },
  )
  add(
    'knowledge',
    'citation_rate',
    '%',
    '检索结果较少被引用时检查相关性',
    (r) => ['query', 'used'].includes(r.type),
    (rs) =>
      (rs.filter((r) => r.type === 'used').length /
        Math.max(1, rs.filter((r) => r.type === 'query').length)) *
      100,
  )
  return output
}
