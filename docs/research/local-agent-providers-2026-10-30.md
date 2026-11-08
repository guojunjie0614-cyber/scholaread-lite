# ScholarLite 本机 Agent 接入调研

调研日期：2026-10-30。范围：T3 Code 的公开实现、Codex App Server、Claude Code／Agent SDK 与 ACP。本文仅新增调研记录，没有安装依赖、启动模型对话或读取凭证。

## 结论

推荐采用「应用持有聊天记录与论文引用，主进程通过 provider adapter 管理本机 Agent」的结构。第一条完整链路优先实现 Codex App Server；Claude 的长期实现首选官方 TypeScript Agent SDK 的 streaming input，指定用户已安装的 Claude Code 可执行文件。若首版明确不引入 SDK，可以先支持 Claude CLI 的双向 stream-json，但需自行承担控制协议、审批与版本兼容。

ACP 适合作为第三种 adapter 扩展其他支持 ACP 的 Agent。它不能把任意 CLI 自动变成同等能力的聊天后端；图片、会话恢复、权限交互必须按实际协商能力展示。

这套方式调用本机安装、登录的 Agent 运行时；模型推理通常仍由对应远程服务完成。它不等同于本地离线模型。

## T3 Code 实际做了什么

核对的官方仓库为 [pingdotgg/t3code](https://github.com/pingdotgg/t3code)，本次读取固定在提交 `960d5761c13f68a2f10635bcd26489a5fa404ec1`。以下结论来自源码，而非第三方介绍。

- Codex 适配器使用 `effect-codex-app-server`，provider 层启动本机二进制，建立客户端并执行 `initialize`、`initialized`；对话适配器明确使用 `codex.app-server` 协议及 `thread/resume`。[CodexProvider.ts](https://github.com/pingdotgg/t3code/blob/960d5761c13f68a2f10635bcd26489a5fa404ec1/apps/server/src/provider/CodexProvider.ts#L462)、[CodexAdapterV2.ts](https://github.com/pingdotgg/t3code/blob/960d5761c13f68a2f10635bcd26489a5fa404ec1/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1420)
- Claude 适配器使用 `@anthropic-ai/claude-agent-sdk`；源码实际调用 `query()`、`interrupt()`，传入 `resume` 和 `canUseTool`。不是把终端显示文本抓出来当聊天消息。[ClaudeAdapterV2.ts](https://github.com/pingdotgg/t3code/blob/960d5761c13f68a2f10635bcd26489a5fa404ec1/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1035)、[中断](https://github.com/pingdotgg/t3code/blob/960d5761c13f68a2f10635bcd26489a5fa404ec1/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1222)、[恢复与审批选项](https://github.com/pingdotgg/t3code/blob/960d5761c13f68a2f10635bcd26489a5fa404ec1/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1498)
- T3 将各个运行时放在统一 driver 结构下，内置 Codex、Claude 和 ACP Registry 等 driver。值得借鉴的是适配边界；ScholarLite 无需复制它面向开发的工作区、Git 与远程控制系统。[builtInDrivers.ts](https://github.com/pingdotgg/t3code/blob/960d5761c13f68a2f10635bcd26489a5fa404ec1/apps/server/src/provider/builtInDrivers.ts)

## 接口选择

| 后端 | 推荐入口 | 会话、图片与控制 | 对 ScholarLite 的判断 |
| --- | --- | --- | --- |
| Codex | `codex app-server` 的 stdio JSONL／JSON-RPC | `thread/start`、`thread/resume`；turn 文本和 `localImage`；增量事件；`turn/interrupt`；服务端审批请求 | 首个落地后端，所需聊天能力覆盖完整 |
| Claude Code | Agent SDK streaming input | 长期双向输入；原生 image block；resume；interrupt；`canUseTool` | Claude 的长期首选，少维护一套控制协议 |
| Claude CLI | `claude -p`＋stream-json | 输出事件、session id、显式 `--resume`；双向输入与控制需完整实现 | 可作为不新增依赖的路径；不要只把提示词放进 argv 然后解析最终文本 |
| ACP Agent | 初始化协商＋`session/*` | 文本必需；image、load/resume 等按能力协商；流式 update、cancel、权限请求 | 扩展路径，适配后按 capability 开启功能 |

Codex 官方文档给出的基本生命周期是初始化、创建／恢复 thread、启动 turn、读取 `item/*` 通知、等待完成；中断后应等最终状态。输入支持远程图片和本地图片路径，工具执行可以触发审批；主进程应把这些请求转成 UI 事件并返回用户决定。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

Claude 官方将 streaming input 明确列为推荐输入方式，覆盖图片、持续会话、排队与中断；单条字符串 query 缺少直接图片和实时控制。SDK 通过 `canUseTool` 接收工具审批或提问，并能用显式 session id 恢复本机已有上下文。[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[审批与提问](https://code.claude.com/docs/en/agent-sdk/user-input)、[会话恢复](https://code.claude.com/docs/en/agent-sdk/sessions)

Claude CLI 具备 `--output-format stream-json --verbose --include-partial-messages`，最后返回 result；多并发会话必须保存并显式传 `--resume <id>`。停止按钮优先结束当前 turn：官方建议 SIGINT 或 SDK `interrupt()`，而非直接 SIGTERM，否则可能留下未完成 turn。[Run Claude Code programmatically](https://code.claude.com/docs/en/headless)

ACP 的 v1 是当前稳定协议，v2 为 Draft。`initialize` 决定 `promptCapabilities.image` 等能力；`session/load` 要求 `loadSession`，`session/resume` 另有能力字段。取消发送 `session/cancel` 后仍要接受尾部更新并等 cancelled 完成；权限请求必须有明确响应。[初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)

## 本机已有登录与订阅

Codex App Server 提供 `account/read` 和登录接口，区分 ChatGPT、API key 等账号类型。应用通过官方接口显示登录状态，使用本机 CLI 的实际配置；不自行提取、复制 token，也不把某个 provider 的会话或登录状态当作其他 provider 的状态。CLI 已安装不等于已登录、模型可用或配额充足。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

Claude 的旧文档摘录容易造成误判。当前官方 Legal and compliance 页面明确允许产品运行原版 Claude Code，条件包括不修改二进制、不删减认证方式、终端用户自行用自己的订阅／API／推理服务凭证、服务商不代付或转售用量。产品应调用原版运行时并让用户自行登录。[Claude Code 产品集成条件](https://code.claude.com/docs/en/legal-and-compliance)

2026-10-07 更新的官方帮助页写明：通过 Claude plan 登录时，Agent SDK 和 `claude -p` 仍使用订阅限额；使用关联 Console 组织的 API key 则走相应 API 额度。因此「SDK 必须 API key、CLI 一定可以订阅」并不是当前正确区分；应按实际认证方式展示用量来源。[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

## 应用层必须自己持有的状态

以下为方案建议：

1. **聊天记录独立存储。** 应用的 conversation/message/attachment/reference 是 UI 的事实来源，另存 provider instance 与 native session id。Agent 原生 session 用于续聊，不能成为论文引用和用户历史的唯一存档。
2. **模型能力动态读取。** 图片能力不只由 UI 是否有上传按钮决定，还取决于当前 provider、协议与模型。暂不支持图片时阻止发送并说明原因，不能静默丢图。
3. **本机路径由主进程管理。** 保存图片附件与论文上下文快照，发送文本和结构化图片；不能只在提示词里写一个图片文件名就假定模型看过图。
4. **只读论文助手是首个权限档位。** 给 Agent 当前论文的上下文及受控检索／读取能力；按运行时真实权限配置关闭无关写入、shell 和网络能力，避免自动继承用户全局插件或宽权限。提示词不是权限边界。
5. **统一事件而不强行统一全部能力。** 最少统一 text delta、tool activity、approval request、usage、completed、interrupted、failed。保留 provider 原生信息用于定位；恢复失败时不要假装上下文还在。
6. **切换 provider 是切换执行会话。** 旧消息保持可读；若需跨 provider 续接，明确创建新 native session，并发送选定历史或摘要，不能把旧 native session id 交给新 provider。

## 本次未执行、实施时需验证的事项

父任务已只读确认本机 Codex CLI `0.163.0` 和 Claude Code `2.1.310` 存在。以下仍需在实施阶段通过定向检查确认：

- 当前安装版本提供的真实 schema 与官方文档是否一致；Codex 可用本机生成 schema 固定 adapter 类型。
- Electron 从 Finder／Dock 启动后的 PATH、二进制路径、原版 Claude 的可执行文件设置与 CLI 原有配置能否正确复用。
- 当前账号登录、图片模型能力和限额；本文未发起推理请求。
- 一次文字、一次图片、两轮续聊、停止、进程重启恢复与审批拒绝的真实链路。
- Claude SDK 与已安装 Claude Code 的兼容性；引入 SDK 属于新增第三方依赖，实施前依用户工程规则处理授权。

