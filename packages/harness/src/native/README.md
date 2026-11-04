# Native harness 交付说明

入口为 `createNativeHarness({ providers, models })`。providers 支持注入 `ModelProvider`，或通过兄弟模块 `createProvider` 创建配置实例。带 `req.provider` 时，按 core 契约把 `req.model` 当作已解析的厂商 ID，价格/上下文元数据使用引擎传入的 req.modelConfig，不反推别名。直接调用时未传 req.provider 才查显式别名。

## 已实现

- 最多 50 次 provider 调用，最后一次禁止工具。要求 schema 时使用独立的无工具结果轮并透传 schema；普通 JSON 用 JSON.parse，围栏 JSON 用 core extractJsonBlock，schema 校验留给 engine。
- 六个工具：read_file、write_file、edit_file、list、grep、显式启用的 bash。精确替换拒绝空、缺失和多个匹配（包括重叠）；文件读写限 1 MB，grep 是字面字符串搜索。
- 工具先检查词法路径和真实路径均在 cwd 内；两种路径均须满足 writeScope。缺失 scope 禁写，拒绝硬链接/非普通文件写入，先检查权限再创建目录，截断前核验 inode。
- started/message/tool_call/usage/compacted 事件；使用 core estimateTokens、addUsage、matchGlob、listFiles、extractJsonBlock。缺失用量由估算补齐并发 system 消息说明；缓存输入按 cachedInput 计费，未配置则沿用输入价。
- 达到上下文窗口 80% 时，每个请求最多压缩一次早期工具回包，保留调用/回包配对、用户提示和最近六条消息，记录前后 token 数。没有可压缩内容时不虚报压缩。
- 不保存会话历史，resume:false；每次调用产生新 sessionId，传入旧 ID 也不会报错。引擎在 session:resume 时注入上一轮产物清单，跨进程行为保持一致。
- 整体取消/超时覆盖 provider 和工具；拒绝超出 Node 定时器范围的 timeout。事件、最终结果、工具回包及错误脱敏，执行工具保留原始参数，避免破坏精确字符串替换。

## bash 的实际限制

使用 macOS `/usr/bin/sandbox-exec`，默认拒绝权限；不支持的平台返回工具错误，不执行命令。测试在当前 macOS 实际创建并更新授权文件，校验越界拒绝和取消行为。

- cwd 树中有任何符号链接便拒绝启动。因此带 node_modules workspace 链接的常见仓库不能直接使用 bash。这是当前保守实现的明确限制；文件工具仍按词法/真实路径双重检查使用。
- 启动前扫描 cwd；可写文件存在硬链接则拒绝整个命令，沙箱禁止创建硬链接和符号链接。
- 只授权 scope 内普通文件的创建和数据写入。不给目录写权限、unlink 或元数据写权限，mkdir/rm/mv/chmod/原子重命名保存等操作会失败。可用 write_file 的前置授权流程创建需要的目录。
- cwd 外仅允许 shell/系统运行库所需路径读取：/bin、/usr/bin、/usr/lib、/System/Library、/Library/Apple/System/Library、null/随机设备及 cwd 祖先目录本身。没有网络权限。执行文件限于这些系统目录；Homebrew/项目自带程序及依赖其他路径的命令可能失败。
- 禁止 setsid、setpgid、posix_spawn，阻止子进程脱离进程组；依赖 posix_spawn 的程序也受限。结束/取消/超时清理后台进程组。子进程不继承环境凭据、BASH_ENV 或 DYLD 配置，输出限 1 MB。
- 路径/inode 核验与启动扫描是前置防护，不是针对外部进程并发修改目录或增加硬链接的隔离机制。Node 文件 API 没有本实现所需的 dirfd 相对原子操作，不能声明消除了外部恶意并发文件系统变更的所有竞态。

## 协议及上游待处理项

- core 无 MCP 连接、工具注册或调用协议，因此能力明确为 mcp:false，与简报“除 customProvider 全 true”有差异，不能声称支持 MCP。resume:false，customProvider:true；其余已实现能力如声明所示。
- native 声明 requiresProvider 和 providerProtocols（内置两种协议及已注入实例的协议），引擎按能力通用校验。这两个字段与 req.modelConfig 已纳入协议（types.ts）。
- 角色、节点等上游 writeScope 的有效交集由上游负责；native 只执行收到的 scope，缺失时禁写，不自行扩大范围。
- HarnessEvent.usage 没有 estimated/note 字段，估算声明暂用 system message；如需机器可读估算标记，应扩展 core 协议。
- 本实现不持久化会话、不接入 MCP、不重复实现 schema 校验，未修改 core 协议。只有模型价格可得时才计算模型成本。

测试使用临时目录、注入 mock provider 或拦截 fetch，不进行真实模型网络调用，不使用真实密钥。
