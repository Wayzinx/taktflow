# 开发简报：M8 后端 C8（严格结构化输出：原生约束、完整校验、修正追问）

**先读**：
- `AGENTS.md`
- `docs/design/31-Harness与LLM自由搭配和严格结构化输出.md` §5
- `docs/dev/m8-backend-c7.md`（上一轮：协议桥）
- `packages/core/src/engine/harness.ts`（`callHarness`）
- `packages/core/src/engine/schema.ts`
- `packages/core/src/util/json-block.ts`
- `packages/core/src/engine/nodes/review.ts`、`review-schema.ts`
- `packages/core/src/engine/completion*`（`checkCompletion`）
- `packages/harness/src/{claude-code.ts,codex.ts}`
- 其余用 `parseResult` / `validateSchema` 解析模型输出的地方：`eval/model.ts`、`eval/replay.ts`、`route/index.ts`、`lead/schema.ts`、`defects/*`

**协议**已写好，不要再改 `packages/core/src/{types,interfaces,api}.ts`：
- `EventPayloads['output.invalid']`：`{ attempt, errors, excerpt? }`
- `EventPayloads['output.repaired']`：`{ attempts }`
- `InvocationStart.repair`：第几次修正追问
- `TaktConfig.output.repairs`：缺省 2，0 为不追问

**通用要求**：
- 中文错误信息。
- 不调用付费模型，不发真实网络请求。
- 三个 demo 不变红。
- **不要动 `packages/web/`**。
- 本机 4870、4888 端口有 serve，不要停、不要发请求，也不要碰 `~/taktflow-playground`。

---

## 背景（真实发生的）

真实运行里，`design` 节点的产物和自检都对，但最后的 json 代码块里先抄了一遍要求的 schema，再写结果，一个块里有两个 JSON 值。

```
{"type":"object","required":["checks"],"properties":{...}}
{"checks":[{"id":"c1","pass":true,"evidence":"…"},{"id":"c2","pass":true,"evidence":"…"}]}
```

- 提取失败，`data` 是 `undefined`，`checkCompletion` 把 c1 / c2 都判成未满足。
- 节点以「完成标准未满足：c1、c2」失败，整个运行 failed。
- 只能人工重试，又跑了一遍 6 分钟的模型调用。
- 提取已经先修了（9302e3d：块里有多个 JSON 值时取最后一个）。但根本问题在两点：格式错误和「模型判定没做完」被混为一谈；格式错了也没有追问修正。

## 实测：原生约束的真实行为

两组都抓过请求，样本在 `.taktdev/captures/`。

**Claude Code `--json-schema '<schema>'`**
- 它额外注册一个 `StructuredOutput` 工具，`input_schema` 就是传入的 schema，不做转换。这个工具对接 DeepSeek 等任何支持工具调用的模型都能用。
- 模型没调这个工具时，它自己再追问一次（`[structured-output-enforce] You MUST call the StructuredOutput tool…`）。
- 仍然没调时，最终 `result` 事件是 `subtype: "success"`、`structured_output: null`。**null 必须当作「没给结构化结果」**，不能当成功。

**Codex / TRAE `exec --output-schema <file>`**
- 请求里是 `text.format = { type: "json_schema", strict: true, name: "codex_output_schema", schema }`，schema 原样透传。
- OpenAI 的严格模式要求：每个对象都有 `additionalProperties: false`，所有属性都列在 `required` 里。我们的 schema（如 `REVIEW_SCHEMA`）有可选字段，直接传给 OpenAI 会 400。
- 最终的 `agent_message` 文本就是 JSON。

## 任务 1：完整的 JSON Schema 校验

- core 加依赖 `ajv`（8.x），用 `ajv/dist/2020`，配置 `allErrors: true, strict: false`。按 schema 对象缓存编译结果。
- **`schemaErrors(value, schema): string[]`**：
  - 返回「路径：原因」的中文列表，例如：
    - `$.checks[0].pass：应为 boolean`
    - `$.verdict：取值须为 approve / request_changes / reject 之一`
    - `$.issues[2]：缺少必填字段 description`
    - `$：不允许的字段 extra`
  - 覆盖 type（含类型数组）、required、properties、additionalProperties、items、enum、const、minItems / maxItems、minLength / maxLength、pattern、minimum / maximum、anyOf / oneOf / allOf、本地 `$ref` / `$defs`。
- **`validateSchema(value, schema, path?)`**：保持抛错语义，消息为全部错误拼接，所有现有调用点不改。
  - 现有测试里断言旧错误文本的，按新文本更新。
  - 确认 commands / steward / undo 这几处的错误提示依然可读，它们会显示给人看。

## 任务 2：提取与原生约束

**提取**

- 在 `util/json-block.ts` 或 `engine/schema.ts` 加 `extractStructured(text, schema?)`，依次尝试：
  1. 最后一个闭合的 json 代码块：单个值；或多个值时取**最后一个能通过 schema 的**。没有 schema 时取最后一个。
  2. 整段回复本身是合法 JSON。原生约束时就是这种形态。
- 返回 `{ value?, problem? }`。problem 是「没有 json 代码块」「json 代码块未闭合」「json 代码块无法解析：<JSON.parse 的错误>」之类，用于追问。

**原生约束**

- **claude-code**：
  - `req.resultSchema` 存在时加 `--json-schema <JSON>`。
  - 从 `result` 事件读 `structured_output`，非 null 才填 `result.structured`。
  - 声明 `structuredOutput: true`。
- **codex / trae**：
  - `req.resultSchema` 存在时，先用 `toStrictSchema(schema)` 转成严格形态：
    - 每个对象补 `additionalProperties: false`；
    - 可选属性列进 `required`，类型放宽为可为 null。
  - 转不了时不用原生约束，照旧走提示词 + 校验，记一条 `log` 说明原因。转不了的情况：
    - `additionalProperties` 为 true 或是一个 schema（自由键的 map）；
    - 用到严格模式不支持的关键字。
  - 转好的 schema 写进临时文件，加 `--output-schema <file>`，用完删除。
  - 最终文本解析成 JSON 后，用 `dropNullOptionals(value, 原 schema)` 删掉原本可选、模型给了 null 的字段，再填 `result.structured`。
  - 声明 `structuredOutput: true`。
- **引擎提示词**：harness 支持原生约束时，提示词改成「最终结果按要求的结构返回（满足：…）」，不再要求 json 代码块。不支持时保持现状。

## 任务 3：修正追问（`callHarness`）

**校验**

harness 返回 `ok` 后，按顺序收集错误，任一项出错就算「格式不过」：
1. 提取：`result.structured`，没有就用 `extractStructured`。
2. `schemaErrors`。
3. 节点给的**语义校验**：新增可选回调 `validateOutput?: (data) => string[]`，由调用方传入。
   - 评审节点作者回应：先 `normalizeResponses`，再按 `assertResponses` 的规则列出全部不对应项，不在第一个就抛。
   - 完成标准：检查项缺失或 id 对不上属于格式错误。
   - 某项 `pass: false` **不是**格式错误，是模型的真实判定，照旧按「完成标准未满足」失败，不追问。

**追问**

- 格式不过且还有次数（`config.output.repairs`，缺省 2）时：
  1. 记 `output.invalid`：`attempt`、`errors`（最多 20 条），`excerpt` 是输出末尾约 2000 字，脱敏后存。
  2. 用**同一个** harness / 模型 / provider / pairing（含桥接）追问。
     - 能续聊时（`capabilities.resume` 且有 sessionId）就续聊，提示词大意：
       > 上一条回复的结构化结果没通过校验：
       > - <错误 1>
       > - …
       > 不要再改文件，也不要重复解释，只按要求的结构给出修正后的完整结果。
     - 不能续聊就新开一次调用，把 schema、上一条回复末尾的约 8000 字和错误列表交给它。
     - 两种都设 `readOnly: true`。
  3. 这次调用照常记 `invocation.started` / `.finished`，`repair: n`；usage 计入节点和预算。
- 通过：记 `output.repaired { attempts }`，结果用修正后的值。
- 次数用完仍不过：抛 `FailureError('结构化结果不符合要求：<前 5 条错误>', 'output.invalid', <错误摘要>)`，节点失败，可以用 `run.retry` 重试。
- `data === undefined` 时报出的是提取问题（如「没有 json 代码块」），**不再**误报成「完成标准未满足」。

## 任务 4：其他调用点

- lead、route、eval（model / replay）、defects（attribution / checkpoint-attribution）里，凡是「调一次 harness → 解析 → 校验」的地方，都抽成同一个 helper，例如 `runStructured(harness, request, schema, { repairs, validate?, onInvalid? })`，统一走提取 + 校验 + 追问。
- 能接事件的地方（有 host / emit）也记 `output.invalid` / `output.repaired`。
- 来不及迁的，列在交付说明的「没做什么」里。

## 任务 5：测试

- **`schemaErrors`**：每类关键字至少一例，中文路径和原因要对。旧调用点的行为不变（抛错）。
- **`extractStructured`**：
  - 单块、多值块（schema + 结果，按 schema 选中结果）、整段 JSON；
  - 未闭合、无块、坏 JSON 的 problem 文本。
- **`toStrictSchema` / `dropNullOptionals`**：
  - `REVIEW_SCHEMA`、`RESPONSES_SCHEMA`、完成标准 schema 能转成严格形态；
  - 自由键 map 报不支持；
  - null 能删回去。
- **适配器**：
  - claude-code 加了 `--json-schema`；`structured_output` 为 null 时不填 structured。
  - codex / trae 写临时 schema 文件，加 `--output-schema`，用完删掉。
  - 用假可执行文件跑。
- **引擎**（mock harness）：
  - 第一次输出缺字段 → `output.invalid` → 追问（断言 `readOnly`、续聊的 sessionId 和提示词里的错误列表）→ 第二次正确 → `output.repaired`，节点成功。
  - 次数用完 → 节点以 `output.invalid` 失败，消息列出错误。
  - `repairs: 0` → 不追问，直接失败。
  - 用真实样本：块里先 schema 后结果 → 直接通过，不追问。
  - `pass: false` 不追问，照旧按完成标准失败。
  - 评审作者回应少一条 → 追问后补齐 → 继续 review。
- **回归**：`npm test` 全绿，`npx tsc -b` 通过。

## 交付

- 交付说明只写在最终输出里：做了什么、测试结果、没做什么、已知问题。不要在源码目录放文档。
- 不提交、不推送。
