# ScholarLite 文档索引与架构说明

本目录汇总 ScholarLite 的系统架构概览、模块职责边界及各阶段工程调研与修复记录。

---

## 顶层文档

| 文档 | 说明 |
| --- | --- |
| [../README.md](../README.md) | 项目使用说明、运行命令、翻译与本机 AI 配置、目录结构与测试入口 |
| [../VALIDATION.md](../VALIDATION.md) | 各阶段版面重排、OCR、分类书库、翻译与本机 AI 对话的验收记录 |
| [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | Open Intelligent UI / OpenUI 运行时及第三方组件许可声明 |
| [../assets/ICON.md](../assets/ICON.md) | 应用图标（透明侧栏标志、白底主图标与 macOS `.icns`）规格与打包说明 |
| [../renderer/src/assets/fonts/README.md](../renderer/src/assets/fonts/README.md) | 内置离线字体（Inter、Schibsted Grotesk、Noto Sans SC）来源与 OFL 许可 |

---

## 系统架构概览

ScholarLite 采用 **Electron 主进程 + 沙箱化 React 渲染进程 + 共享类型契约** 的三层结构，所有持久化数据存储在本机 `~/Library/Application Support/ScholarLite/`：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Renderer (React 19 + PDF.js + KaTeX + OpenUI)                           │
│  ├─ Library / LibraryHome      文献库、多级分类树、筛选排序、外部库导入 │
│  ├─ reflow/ (Engine v28)       PDF 区域几何、公式组归属、行内二维数学、 │
│  │                             算法块、图版与图注绑定、作者/页眉过滤    │
│  ├─ Reader / FigureBlock /     重排阅读、原页模式、按需高清裁图、       │
│  │  MathBlock / InlineText     公式 LaTeX 校对、流式中文原位替换        │
│  └─ NotesPanel / ChatPanel /   高亮批注、大纲跳转、本机 Agent 对话、    │
│     VisualAnswer               引用卡片与 OpenUI 交互图表/控件          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ ContextBridge IPC (electron/preload.ts)
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Main Process (Node ≥ 22 + node:sqlite WAL)                              │
│  ├─ db.ts / reanchor.ts        文献、块、分类树、笔记重锚定、进度持久化 │
│  ├─ library-import*.ts /       Zotero (只读 WAL) 与文件夹导入、         │
│  │  metadata-backfill.ts       Crossref/arXiv 与 PDF 首页元数据后台补全 │
│  ├─ translate.ts / magpie.ts / 多 Provider 并发流式翻译、优先级队列、   │
│  │  translation-stream.ts      科学上下标与二维数学占位符保护与缓存校验 │
│  ├─ ocr.ts / formula-ocr.ts    macOS Vision 本地文字 OCR、pix2tex 公式  │
│  └─ chat/ (service / store /   会话分支与附件管理、Codex App Server 与  │
│     codex / claude / agy)      Claude Code CLI 适配器、只读安全沙箱     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 关键不变量与工程约束

1. **版面重排质量门（`REFLOW_ENGINE_VERSION = 28`）**：
   - 公式与算法区域先于普通段落确定唯一字形归属，裁剪框必须为页内有限正面积矩形（[`shared/reflow-validation.ts`](../shared/reflow-validation.ts)）。
   - 行内复杂上下标、嵌套下标、圈号与积分上下限通过 `mathPosition` 保留二维几何相对位置，同时维持 `Block.text` 的规范字符顺序与笔记高亮偏移一致（[`renderer/src/reflow/inline-text.ts`](../renderer/src/reflow/inline-text.ts)）。
   - 整篇解析全部通过校验后才在 SQLite 事务内更新块缓存并执行笔记唯一重锚定（[`electron/reanchor.ts`](../electron/reanchor.ts)），已人工确认的公式排版在重新解析时保留。
2. **流式翻译与数学保护**：
   - 发送前将科学上下标、内联变量与连续二维数学空间组编码为受保护占位符（[`shared/translation-scripts.ts`](../shared/translation-scripts.ts)）；返回后逐段校验占位符完整性与顺序，完整还原 `TextRun` 的 `mathPosition` 与字形样式后才写入缓存并更新界面。
3. **本机 Agent 对话边界**：
   - 应用自身 SQLite（[`electron/chat/store.ts`](../electron/chat/store.ts)）是会话、消息分支、论文引用与图片附件的唯一事实来源；本机 Codex App Server 或 Claude Code 仅作为受控推理运行时，工作目录隔离在应用数据目录 `chat/` 下，关闭文件写入与任意命令执行。

---

## 专题调研与修复归档（`docs/research/`）

### PDF 版面重排与公式链路

- [pdf-reflow-diagnosis-2026-10-30.md](research/pdf-reflow-diagnosis-2026-10-30.md)：重排管线结构诊断（公式截断、反向裁剪框、作者区过滤、图注分类与原稿回退分析）
- [pdf-reflow-formula-audit-2026-10-30.md](research/pdf-reflow-formula-audit-2026-10-30.md)：PDF 重排公式链路审计（字形唯一归属、英语下标边界与相邻公式竞争根因）
- [pdf-reflow-mature-systems-2026-10-30.md](research/pdf-reflow-mature-systems-2026-10-30.md)：成熟文档解析路线对比（MinerU、Docling、Marker、GROBID、Nougat 能力边界与许可证核查）
- [pdf-reflow-fix-2026-10-30.md](research/pdf-reflow-fix-2026-10-30.md)：重排引擎 v27 完整区域归属、行内积分几何、无框算法与阅读分类修复交付记录

### 翻译与数学结构保护

- [translation-fix-2026-10-30.md](research/translation-fix-2026-10-30.md)：重排引擎 v28 字形恢复、分段翻译真实进度统计与二维数学空间结构保护验收记录

### 本机 Agent 接入与 AI 对话

- [local-agent-providers-2026-10-30.md](research/local-agent-providers-2026-10-30.md)：本机 Agent 运行时接入调研（Codex App Server、Claude Code / Agent SDK 与 ACP 协议对比）
- [scholarlite-ai-chat-plan-2026-10-30.md](research/scholarlite-ai-chat-plan-2026-10-30.md)：论文 AI 对话交互设计、消息分支、跨段/译文引用锚定与安全权限边界方案
- [agy-integration.md](research/agy-integration.md)：Antigravity (`agy`) Headless `stream-json` 协议适配、读图验证与工具边界记录
