#!/usr/bin/env bash
# hello-delivery 演示：失败 → 判决 product_bug → 路由开发修复 → 第二轮通过。
#
# 每次运行都会：
#   1. 清理示例项目里的存放区 / 运行 / 对象 / 待办；
#   2. 从 fixtures/greet.buggy.js 恢复 src/greet.js 的缺陷版本（可重复运行）；
#   3. 创建需求、导入 PRD、用 mock harness 跑完整 sdlc 流水线；
#   4. 校验运行 succeeded、dev-test-loop 恰好 2 轮、judge.verdict 事件 1 条、审计链通过。
# 退出时恢复 src/greet.js 的缺陷版本，运行证据保留在 .takt/ 里。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PROJECT="examples/hello-delivery"
EXAMPLE="$ROOT/$PROJECT"
TAKT=(npx tsx packages/cli/src/index.ts --project "$PROJECT")
REQ=REQ-001

restore_bug() {
  cp "$EXAMPLE/fixtures/greet.buggy.js" "$EXAMPLE/src/greet.js"
}
trap restore_bug EXIT

echo "==> 清理运行产物"
rm -rf "$EXAMPLE/.takt/workspaces" "$EXAMPLE/.takt/runs" "$EXAMPLE/.takt/objects"
rm -f "$EXAMPLE/.takt/attention.jsonl"
mkdir -p "$EXAMPLE/.takt/workspaces"

echo "==> 恢复带缺陷的 src/greet.js"
restore_bug

echo "==> 创建需求"
"${TAKT[@]}" req new "问候语支持空名字"

echo "==> 导入 PRD"
"${TAKT[@]}" ws put "$REQ" inputs/prd.md "$EXAMPLE/fixtures/prd.md" --kind input --reason "演示物料"

TMP="$(mktemp -d)"
cleanup_tmp() { rm -rf "$TMP"; }
trap 'cleanup_tmp; restore_bug' EXIT

echo "==> 运行 sdlc（mock harness，自动通过人工节点）"
"${TAKT[@]}" --json run sdlc --req "$REQ" --harness mock --auto-approve > "$TMP/run.json"

RUN_ID="$(node -e 'const fs=require("fs");const run=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!run.runId)throw new Error("run --json 缺少 runId");process.stdout.write(run.runId)' "$TMP/run.json")"
echo "    运行 ID：$RUN_ID"

echo "==> 校验审计哈希链"
"${TAKT[@]}" --json audit verify "$RUN_ID" > "$TMP/audit.json"

echo "==> 校验演示结果"
CHECK_STATUS=0
node - "$TMP/run.json" "$TMP/audit.json" "$EXAMPLE/.takt/runs/$RUN_ID/events.jsonl" "$EXAMPLE/.takt/workspaces/$REQ" <<'NODE' || CHECK_STATUS=$?
const fs = require('node:fs')
const path = require('node:path')
const [runFile, auditFile, eventsFile, workspace] = process.argv.slice(2)
const run = JSON.parse(fs.readFileSync(runFile, 'utf8'))
const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8'))
const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))

const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok, detail }) }
check('运行状态 succeeded', run.status === 'succeeded', `status=${run.status}`)
const loop = run.nodes?.['dev-test-loop']
check('dev-test-loop 迭代 2 轮', loop?.iteration === 2, `iteration=${loop?.iteration}`)
check('dev-test-loop 成功', loop?.status === 'succeeded', `status=${loop?.status}`)
// 验收要求：整个运行恰好 1 条 judge.verdict 事件，且判决为 product_bug、路由到 fix-code。
// 注意：当前 core 在第二轮无失败时仍会发一条空 verdicts 的事件，这里严格按事件条数断言。
const verdicts = events.filter((event) => event.type === 'judge.verdict')
check('judge.verdict 事件 1 条', verdicts.length === 1, `count=${verdicts.length}`)
const verdict = verdicts[0]?.data?.verdicts?.[0]
check('首轮判决为 product_bug', verdict?.category === 'product_bug', `category=${verdict?.category}`)
const routed = verdicts[0]?.data?.routed ?? []
check('判决路由到 fix-code', routed.some((route) => route.to === 'fix-code'), JSON.stringify(routed))
// CLI 的审计结果必须明确返回 ok: true。
check('审计链通过', audit.ok === true, JSON.stringify(audit))
const summary = JSON.parse(fs.readFileSync(path.join(workspace, 'evidence/summary.json'), 'utf8'))
const expectedIds = ['TC-GREET-001', 'TC-GREET-002']
check('最终两条用例全部通过', Array.isArray(summary.cases) && summary.cases.length === 2 && expectedIds.every((id) => summary.cases.some((item) => item.id === id && item.status === 'passed')), JSON.stringify(summary))
const emptyName = JSON.parse(fs.readFileSync(path.join(workspace, 'evidence/TC-GREET-002/result.json'), 'utf8'))
check('空名字实际返回 Hello, stranger!', emptyName.id === 'TC-GREET-002' && emptyName.status === 'passed' && emptyName.actual === 'Hello, stranger!', JSON.stringify(emptyName))
check('质量报告已生成', fs.existsSync(path.join(workspace, 'reports/quality.md')), 'reports/quality.md')

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : ` (${item.detail})`}`)
const failed = checks.filter((item) => !item.ok)
if (failed.length) {
  console.error(`\n演示校验失败：${failed.length} 项不通过`)
  process.exit(1)
}
console.log('\n演示校验全部通过。')
NODE

echo "==> 需求状态"
"${TAKT[@]}" status

echo
echo "演示执行结束（校验退出码：${CHECK_STATUS}）。运行证据保留在 $PROJECT/.takt/runs/$RUN_ID/。"
echo "打开 Web 控制台：npx tsx packages/cli/src/index.ts --project $PROJECT serve"
echo "退出时已恢复 src/greet.js 的缺陷版本；想保留修复可自行执行：cp $PROJECT/fixtures/greet.fixed.js $PROJECT/src/greet.js"
exit "$CHECK_STATUS"
