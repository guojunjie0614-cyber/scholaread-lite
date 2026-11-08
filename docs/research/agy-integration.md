# agy 接入记录

日期：2026-10-30。实现：`electron/chat/agy.ts`，导出 `runAgy: RunAgent`；不新增依赖。

## 协议和图片

本机 `/opt/homebrew/bin/agy --help` 提供双向 `stream-json`。输入使用 `{event:"user",message:{content:文本}}`，输出读取 `init`、`step_update` 和 `result`；增量正文来自 `agent_response.text_delta`。保存原生 `conversation_id`，后续传 `--conversation`。发送本轮后关闭 stdin，等最后结果和进程结束；停止向自有子进程发送 SIGINT，再使用共享进程层的有限时清理。[官方 Headless 文档](https://antigravity.google/docs/cli/headless/)

该协议的输入 content 仅支持 text，直接发送 image block 会报错。图片改用原生 `view_file` 工具读取：官方更新记录包含 `view_file` 的图片分辨率选项与 CLI TIFF 查看修复。[官方 Changelog](https://antigravity.google/docs/changelog?tab=cli)

适配器把实际图片复制到应用会话目录，向模型提供清单并要求逐图调用 `view_file`。只有全部图片对应的成功工具事件出现后才发布回答；未读图就返回最终回答会明确失败，防止仅凭文件名生成图像解释。此为工具读取式视觉输入。

## 工具边界

会话目录生成自定义 `scholarlite-reader`，仅开放 `view_file`，禁止子代理、命令和其他工具；初始化出现额外工具则终止。会话 settings 拒绝命令、文件写入、MCP 和 Web，只允许读取附件目录；工具事件若访问目录外路径也终止。CLI 的原生登录仍由用户安装的程序管理，应用不读取凭证或修改全局配置。[Agent 定义](https://antigravity.google/docs/subagents/)、[权限规则](https://antigravity.google/docs/permissions/)

本机 `zsh -ic 'whence -v agy'` 显示用户另有同名 shell 函数。当前调用使用配置的可执行文件和应用继承的环境，不自动加载交互 shell；若该函数负责代理，则真实连接需要应用具备相应代理环境。未读取函数内容或凭证。

## 验证

`node tests/agy-protocol.mjs` 已通过伪 CLI 子进程验证：多段中文增量、显式续聊 ID、实际附件复制及工具读取确认、未读图拒绝、鉴权错误结果、缺失最终结果、额外工具拒绝、SIGINT 停止。未调用真实模型，未验证当前登录、网络连通性或实际模型的图像解释质量。
