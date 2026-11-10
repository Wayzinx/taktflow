# 开发简报：模型目录

范围是设计 32 的模型发现、HarnessInfo 目录字段和 §7 接口。实现涉及 core 协议与配置校验、harness 自带模型、server 缓存与路由，以及 CLI 既有目录的字段补全/测试替身过滤；不涉及 web 或新的 provider 注入方式。

## 接口与字段

- `GET /api/space/runtime/catalog` 返回 `RuntimeCatalog`。已有空间路由分发同时支持 `/api/s/<space>/space/runtime/catalog`。
- `POST /api/space/runtime/catalog/refresh` 接收 `{ target: { kind: 'provider' | 'harness', id } }`，owner 才能调用，返回指定项的 `CatalogList`。刷新 provider 时 embeddings 仍写入缓存，下次 GET 单独返回。
- `CatalogModel`：id、label、contextWindow、maxOutput、reasoning、efforts、defaultEffort、input、toolCall、price、origin、alias、deprecated；可选性见 core/api.ts。price 沿用每百万 token 的美元价格，可包含 cachedInput。
- `CatalogList`：models、fetchedAt、source（live/cache/preset）、error。
- `RuntimeCatalog`：harnesses（HarnessInfo + own + accepts）、providers（id/displayName/protocols/keyPresent/models/embeddings）、pairings、enrichment（ok/unavailable）。
- `HarnessInfo` 增加 icon、ownLabel、install、hidden、testOnly；`HarnessAdapter` 增加可选 `listModels(): Promise<CatalogModel[]>`；`Effort` 提取为命名类型。
- `ModelConfig` 增加 label、maxOutput、reasoning、efforts、defaultEffort、input、toolCall，PATCH 校验同步接受这些字段；默认档给定时必须属于显式 efforts。
- 旧目录回调 getHarnesses/getCatalog 增加可选 includeTest 参数。HTTP 用 `includeTest=1` 传入，默认不返回 mock；执行注册表保留 mock。

## 实现要点

- `provider-request.ts` 统一 URL 与认证头，provider 测试和模型发现共用完整分页结果。OpenAI 用主协议入口，Anthropic 避免重复 v1，Gemini 规范到 v1beta。总请求期限 10 秒，禁止重定向；翻页最多 10 页，超过上限作为失败，不把部分列表用作下架证据。
- `model-catalog.ts` 分开对话和 embedding；发现结果按厂商 ID 去重、保留成功缓存里消失的模型并标 deprecated。每次读取重新合并预设、发现和手填，因此手填修改不用等缓存过期。
- `model-metadata.ts` 按 baseURL 主机、预设、全局唯一模型 ID 匹配 models.dev，只补缺失字段。列表/手填的精确推理档优先；reasoning=true 且没有档位时给 low/medium/high，默认 medium。补全不可用仅改变 enrichment。
- `model-cache.ts` 共用 6 小时缓存和同项刷新去重。provider 缓存位于 cache/models，harness 位于 cache/harness-models，models.dev 位于 cache/models-dev.json。文件保存指纹、fetchedAt 和筛选后的 value，不保存密钥或原始响应。provider 指纹包括实际 baseURL 与主协议；harness 指纹包括命令与覆盖配置的哈希。
- 过期缓存立即返回，后台刷新；强制刷新同步等待。失败不覆盖上次成功缓存，内存短暂退避 30 秒，强制刷新绕过退避。临时文件写完后 rename，损坏缓存重新拉取。
- `runtime-catalog.ts` 并行发现并最多等 2.8 秒，为响应序列化保留余量。无缓存且未完成时返回预设和“正在获取…”。models.dev 慢或失败不阻止 provider 列表返回。缺少密钥不请求 provider。
- Codex 解析 debug models 的 JSON，严格保留 visibility=list。TRAE 的 models 输出已核实为逐行 ID；拒绝混入标题或空格的未知文本。Claude 固定三种别名，通过当前可执行文件的 help 检测 effort。三种命令复用现有脱敏进程执行器，超时 20 秒，不写 transcript。
- 网络通过 `ServerOptions.catalogFetch` 或 ModelCatalog 构造参数注入；测试不请求外部服务。CLI 输出解析测试替换 runProcess，不启动真实 CLI。

## 测试索引

- core/runtime-config/runtime-config.test.ts：手填模型元数据可保存，默认推理档必须属于声明的档位。
- harness/model-list.test.ts：Codex 录制片段解析名称、窗口和推理档；visibility 过滤和 effort 映射；TRAE 逐行公开模型样本及无效格式；Claude help 检测有/无 effort；CLI 列表失败。
- harness/catalog-info.test.ts：品牌、订阅来源、安装提示、hidden/testOnly 与 ACP 预设一致。
- server/model-catalog.test.ts：OpenAI 解析/过滤/手填合并；Anthropic 两种 baseURL 翻页；Gemini 翻页与方法过滤；401；错误脱敏/缺少密钥/格式错误；10 秒超时；缓存命中/跨实例读取/过期单刷新/强制刷新/地址与协议失效；下架与分页上限；models.dev 三层匹配与只补缺；离线补全；harness 缓存/失败/20 秒上限。
- server/runtime-catalog.test.ts：目录并行返回与 mock 过滤；3 秒预算；refresh owner 权限及目标校验；离线补全与缺少密钥。
- 既有 server/catalog.test.ts、server/server.test.ts 更新新增目录字段断言；CLI runtime.test.ts 更新不含 mock 的默认数量断言。

## 边界

未做前端选择器、Claude CLI/ACP 合并、其他 harness 的 listModels、新增 harness 协议注入、额度或负载。Claude 此处仅发现推理档；实际运行的 effortOverride 能力仍由既有适配器声明，不据目录伪造执行支持。

已核对本机 Codex JSON、TRAE 文本、Claude help 与公开 models.dev 小样本；provider 请求/鉴权/翻页通过假 fetch 验证，不把离线测试作为真实 provider 连通验收。

验证命令限定为 `npx vitest run packages/core`、`npx vitest run packages/harness`、`npx vitest run packages/server`、`npm run typecheck`。CLI 目录调整由类型检查覆盖，未另外运行 CLI 包测试。

本次验证：core 100 文件 / 967 用例通过；server 25 文件 / 173 用例通过；harness 39 文件 / 853 用例通过，2 个既有跳过项；typecheck 通过。harness 默认并发时既有 Gemini 假进程的 --version 探测触发 5 秒超时，最终用 `npx vitest run packages/harness --maxWorkers=2` 完整通过，未放宽产品超时或断言。
