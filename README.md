# ScholarLite

一个面向论文阅读的开源桌面阅读器：**多级分类书库 + PDF 版面重排 + 流式中文阅读 + 笔记高亮 + 本机 Agent AI 对话与交互可视化**。
重排与 OCR 在本机运行；翻译可配置自己的 API Key、网关或本地 Ollama，使用远程翻译时会向所选服务发送待译文字。

> 这是对 Scholaread（知我）桌面端的**独立重写**，不是它的分支或破解版：
> 界面语言参考原产品（三栏：文献库 / 重排正文 / 辅助面板），
> 但代码、重排算法、数据层全部重新实现；AI 对话通过用户本机安装的 Agent 接入。

---

## 功能概览

| 模块 | 说明 |
| --- | --- |
| 文献库 | 全宽列表／四列卡片、多级分类树与多归属、Zotero／文件夹外部库导入、期刊／会议简称提取、搜索筛选、批量整理 |
| 重排阅读 | 双栏识别、段落合并、首页层级、二维行内数学与积分定位、完整公式组归属、有框／无框算法区域裁切、作者信息与出版页眉过滤、PDF 字形编码恢复、本地 OCR |
| 原页模式 | 直接渲染 PDF 页面（canvas，最高 2× DPR）并附透明文字选区层，需要对照原稿排版细节时切换 |
| 图片预览 | 双击图表、算法或原稿公式，滚轮围绕光标缩放、拖动查看，按需从 PDF 加载高清细节 |
| 翻译 | 一键切换原文／译文、可见段落优先、逐段流式显示中文与邻页预取；支持 1–16 个 HTTP 并发、二维数学结构保护、断点续译与单段失败恢复，结果本地缓存 |
| 笔记 | 划词高亮（5 色）+ 批注，按偏移量锚定在重排文本上，重新解析时自动唯一重锚，可导出 Markdown |
| 大纲 | 从重排结果里抽取各级标题，随滚动标记当前章节，点击跳转 |
| AI 对话 | 本机 Codex / Claude Code 接入，支持文字与图片、选区引用、续聊与编辑分支、OpenUI 交互图表与滑块控件；Antigravity 接入暂缓 |
| 进度 | 记住每篇文献的阅读位置，重开自动回到上次位置 |
| 导航 | 顶部 ← 返回书库，Esc 逐级退出（先关弹窗／菜单、再清选区、最后回书库） |

### 明确不做（相对原版）

自主深度研究 / Agent 浏览、Pyodide 沙箱、云端重排服务、账号体系与会员额度、遥测上报、热更新。

---

## 快速开始与运行

要求 Node ≥ 22（依赖内置 `node:sqlite`），推荐 Node 24。

```bash
npm install
npm run dev      # 开发：Vite + Electron 热更新
npm start        # 构建并启动；macOS 使用 ScholarLite 名称和正式图标
npm run app:mac  # 创建本机 macOS 应用入口：release/ScholarLite.app
```

- `npm run build` 产出 `dist/`（渲染层）与 `dist-electron/`（主进程与 preload）。
- `npm run app:mac` 使用已有 Electron 运行时生成本机应用入口，无需额外打包依赖。该入口链接当前项目目录，以复用 PDF.js 与已配置的本地 OCR 环境；移动或删除项目会使入口失效，不能作为独立安装包分发。
- 应用统一命名为 **ScholarLite**，采用蓝色折纸 S 图标。侧栏使用透明标志 `assets/app-mark.png`；系统图标使用单层白底的 `assets/app-icon.png`，macOS 图标在 `assets/ScholarLite.icns`（详见 [assets/ICON.md](assets/ICON.md)）。

> 若 shell 里存在 `ELECTRON_RUN_AS_NODE=1`（某些 Electron 工具链会全局设置），启动前需要 `env -u ELECTRON_RUN_AS_NODE npx electron .`。

---

## 文献库与外部导入

书库默认用紧凑列表展示标题、期刊／会议简称、作者、分类、年份和阅读状态，也可切换每行固定四张的卡片视图。来源简称悬停显示全称，也可用简称搜索；已有 PDF 会在后台自动补充可可靠识别的缺失来源与出版年份。点击标题打开论文；点击行空白处选择，多选后可统一整理。通过「… → 查看详情」展开完整元数据与摘要。

- 在左侧「我的分类」旁新建课题分类，可选上级形成多级树结构。同一篇论文可加入多个分类，PDF 和笔记共用一份；父分类汇总全部后代的文献并去重。
- 主书库多选后点击「加入分类」或拖到左侧分类；「添加标签」保留已有标签。父分类视图汇总子分类，移出父分类时会明确标注同时移出其子分类，其他分类归属不受影响。
- 删除分类只移除分类和归属，文献、PDF 与笔记保留；删除文献有独立确认，会删除书库副本及对应笔记、阅读记录，最初导入的源文件保留。
- 「导入 PDF」默认加入当前分类；右侧箭头菜单可指定本次导入的其他分类。没有分类归属的文献集中显示在「未分类」。
- `⌘K` 在主书库搜索标题、作者、标签、来源、年份、分类及 DOI；通过搜索图标旁菜单切换当前分类或全部文献范围，按阅读状态筛选，并按添加时间、阅读时间、标题或年份排序。
- 左侧「最近阅读」仅列最近实际打开过的 10 篇。本次使用中，已有条目保持位置，切换文献只改变选中状态；新进入列表的文献加入顶部，超出 10 篇时移除最久未读项。阅读时间正常记录，重新启动后按最近阅读顺序排列。分类树和最近阅读均可折叠。
- 文献右键或「更多操作」提供详情查看、信息编辑、分类管理、Finder 定位、笔记导出与删除。

### 从其他文献库导入

打开「设置 → 文献库导入」，点击「查找并导入」。应用会检查常见本地文献库位置、Zotero 的自定义数据目录，以及常见文献文件夹；找到可用库后直接导入本地 PDF，不会遍历整台电脑的所有 PDF。未找到时，可用文件夹按钮手动选择数据目录或 PDF 文件夹。

- **Zotero**：只读读取本地 SQLite（含 WAL），导入标题、作者、年份、DOI、来源、摘要、标签与多级分类树，支持托管附件与链接附件（`attachments:` 基础目录），一篇文献的多个 PDF 附件分别保留。
- **本地文献文件夹**：递归读取已下载的 PDF，提取元数据并按目录归类；支持识别 EndNote 的 `.Data/PDF` 目录。小绿鲸等应用只有云端附件时，需要先下载或导出到本地文件夹。

原库保持不变，PDF 复制到 ScholarLite。导入立即生效，显示实时进度与跳过／失败原因；停止会保留已导入项目。重复导入只补新文献或缺失的托管 PDF，不重新加入已手动移除的分类和标签。当前不迁移外部批注、阅读进度或未下载的云端附件。

书库首屏立即返回已保存的文献，来源与年份在后台补全。无结果的 PDF 不会在每次启动反复解析；文件或解析版本变化后重新检查，手动编辑的非空字段不会被覆盖。

---

## 重排、OCR 与公式

打开文献后，阅读器优先读取 PDF 原生文字层，并按区域恢复阅读顺序（当前引擎版本 `REFLOW_ENGINE_VERSION = 30`）。算法版本变化时会重新解析；整篇处理成功且裁剪区域正面积、文字偏移与空间组连续性检查通过后才替换缓存，失败保留上一版。笔记按原文重新定位，不能唯一定位的笔记保留摘录与页码，避免误高亮另一段。

- **分栏与阅读顺序**：文字、绘图与裁图使用同一页内坐标系；双栏文字合行时隔离左右栏，按通栏区域划分阅读顺序，浮动图表与运行页眉不会打断未完句子。
- **图表与复合图版**：图表作为完整区域提取，图内文字不重复进入正文；表格保留完整原稿截图（覆盖末行与底线），表格下的说明独立归为表注并绑定所属表格。矢量图和位图在排序前绑定图注；集中图版保留独立位图边界，识别 `Figure 14.5.1:` 等复合编号，同排按从左至右排列。
- **行间公式与唯一归属**：先确定公式组及所有字形的跨栏唯一归属，再按完整墨迹成员范围生成高清原稿裁片。英文下标不作为正文裁切边界；相连的多编号公式保留为完整公式组，正文仅限制外围留白，不裁掉公式成员。公式截图跟随阅读字号，长公式可横向滚动。
- **二维行内数学与字形恢复**：文字按原 PDF 字号与基线保留上下标及斜体／粗体；复杂同基字上下标、嵌套下标、重音、圈号及扩展字体积分（`CMEX`/`MTEX`）通过 `mathPosition` 保留二维相对位置，规范文字顺序仍供选择与笔记使用。缺失字符按 PDF 字体编码中的可信字形名恢复（如 `squaresolid` → `■`、点号等号 `≐`）；无法恢复的来源行仅对该行以正文字号显示原稿裁片，不把整段降为插图，也不发送损坏文字翻译。
- **算法伪代码**：结合标题、边框、连续行号（含冒号格式）及输入输出／控制语句识别有框或显式无框算法，作为独立原稿裁片展示，保留缩进、行号和二维公式；提取文字供引用和 AI 使用，长行可横向滚动。算法图片在中文模式及关闭图表显示时仍保留。跨页算法目前保留分页区域，不拼接成单个裁片。
- **作者信息与页面装饰过滤**：重排页隐藏首页作者／机构、文末作者传记及相邻作者照片，剔除重复出版页眉、版权页脚与页边水印；保留参考文献、资助说明、技术附录与科研插图。参考文献跨栏、跨页续行保留条目语义，期刊简称不作为章节标题，也不参与翻译。书库元数据和原 PDF 内容不变。

### 本地文字 OCR

扫描页或文字层明显乱码时，自动调用 macOS Vision 识别英文、简体中文及其位置，再进入重排流程。论文图片只在本机处理。首次运行需要 Apple Command Line Tools 的 Swift 编译器；编译结果缓存在应用数据目录，后续直接复用。其他平台会提示当前不支持本地文字 OCR。系统文字 OCR 不恢复数学公式的二维结构，低质量扫描仍需对照「原页」检查。

### 公式转 LaTeX

安装一次独立的本地公式识别环境（需要 `uv`，下载 Python 依赖与模型）：

```bash
sh scripts/setup-formula-ocr.sh
```

依赖放在 `.venv-formula-ocr/`，模型放在 `.models/formula-ocr/`。识别过程离线运行，同一模型进程串行处理公式。

- 对于带文字层的 PDF，优先按原生字形、基线、分数线、上下标、重音、cases 与 aligned 恢复公式结构；遇到无法完整恢复的结构，再使用本地 `pix2tex` 图片 OCR。编辑面板会标出「PDF 结构提取」或「图片 OCR」。
- 悬停或键盘聚焦公式，打开右上角 **… → 识别为 LaTeX**，查看原稿与 KaTeX 排版预览。确认上下标、分式、矩阵和运算符后点击 **确认并采用排版**，结果随文献保存；未确认的识别结果不会替换原稿显示，采用排版后仍可通过菜单中的「使用原稿」恢复。
- 阅读工具栏的 **… → 重新解析版面** 可重新解析当前文献，已有公式结果在能唯一匹配同页公式时保留；若相邻单式合成完整公式组，原单式的人工校对保存在该组的「已保存的单式校对」归档中，不会冒充整组公式。

---

## 配置翻译与中文阅读

设置面板 → 翻译服务，选一个填 Key 即可（保存在 `~/Library/Application Support/ScholarLite/config.json`，权限 `0600`）：

| Provider | 需要的字段 | 说明 |
| --- | --- | --- |
| `magpie` | 网关地址、模型 | 获取网关模型目录后直接选择，无需另填 Key；可按模型支持的档位选择思考程度 |
| `openai` | Base URL、API Key、模型 | 任何 OpenAI 兼容端点（vLLM、OneAPI、硅基流动、OpenRouter…） |
| `deepseek` | API Key、模型 | `https://api.deepseek.com/v1` |
| `ollama` | 地址、模型 | 本地模型，默认 `http://127.0.0.1:11434` + `qwen2.5:7b` |
| `deepl` | API Key | DeepL Free / Pro 端点可改 |
| `google` | API Key | Cloud Translation v2 |
| `echo` | 无 | 调试回显，仅用于验证链路；中文切换会提示配置而不会把回显当译文 |

- **并发与思考程度**：在「设置 → 翻译服务」可设置并发数（1–16，默认 4）和模型思考程度。Magpie 的思考选项来自网关模型目录；切换模型时保留新模型支持的原档位，否则使用「模型默认」。手动填写的 OpenAI 兼容接口和 DeepSeek 使用「模型默认」（省略思考参数）。修改后保存生效，当前文献的旧排队任务会取消，已缓存译文继续复用。
- **优先级与分段流式调度**：当前可见内容按约 1000 字符、最多 3 段的小批提交，后台批次约 4000 字符。按划词、当前可见正文、同页连续缺口、当前页辅助内容、邻页预取依次优先；并发大于 1 时，后台最多占用并发数减 1 个 HTTP 槽位。阅读工具栏点击「查看译文」后，每个完成校验的段落立即在原位置显示中文，并实时统计「本页已译 X/Y 个文本块（缓存恢复 M · 本次完成 N）」。
- **二维数学结构保护與校验**：LLM 请求使用带段落 ID 的流式输出协议。发送前将变量、科学上下标与连续二维数学空间组（`mathPosition`、圈号、嵌套上下标、积分上下限）保护为独立标记，返回后还原并校验完整性与顺序，使译文与原文共享 `InlineText` 二维数学渲染。损坏字符、缺失或乱序标记会被拒绝，自动对缺失或失败段落发起单段恢复（最多重试 3 轮，429 遵守服务端等待时间，401/403 不重复请求）。
- **缓存与重译**：已完成译文按原文内容和目标语言持久化在 SQLite，切换 API、模型、思考程度或并发不清除成功译文；旧缓存按完整数学结构校验后自动复用。阅读工具栏「… → 用当前模型重译本页」显式跳过缓存，新译文校验成功后才替换已有内容。中文摘录添加笔记时定位原段落，不把译文字符偏移套用到原文高亮。

---

## 使用 AI 对话与交互可视化

打开一篇论文，点击右侧面板 **AI** 标签。在输入框下选择**模型**和**思考程度**，应用会自动连接对应的本机 Codex（App Server）或 Claude Code（CLI `stream-json`），沿用其本机登录配置。模型菜单中的来源副标题标明实际连接；右上角菜单可刷新模型列表，或打开「模型设置」填写自定义模型及高级可执行文件路径。

- **选区与图表提问**：选中重排正文或原页文字，右键选择 **发送给 AI 解读** 直接提交；**引用到 AI** 或浮动工具条 **问 AI** 先把来源卡片放入输入框。支持粘贴、拖放或选择 PNG、JPEG、GIF、WebP（每条最多 4 张、每张最多 10 MB）；论文图表、公式预览和原页右上角的 **问 AI** 可直接附上原稿图片。
- **上下文边界**：论文对话自动结合已解析的全文，引用用于强调具体片段；超出上下文预算时会明确提示，不静默截断全文。右上角「… → 新建普通对话」创建独立会话，不自动附带论文正文和元数据。
- **消息操作与会话分支**：悬停消息显示复制、编辑或重新生成图标，回答的更多菜单可存为笔记；选中回答文字点击「添加到对话」会生成可移除的消息引用。编辑先回填输入框，发送时创建新分支并保留原对话历史。历史列表支持重命名与删除（8 秒内可撤销，仅隐藏本应用会话，不删除本机 Agent 自身历史）。
- **安全与环境隔离**：论文解释模式关闭命令执行和文件写入，不新增外部 Agent SDK 依赖，也不读取或复制登录凭证。聊天配置、图片及会话工作目录位于应用数据目录的 `chat/`，消息与分支存储在 SQLite。Antigravity（`agy`）因上游 CLI 1.4.10 工具集限制尚待确认，暂不作为可用渠道展示，连接路径与历史保留。
- **macOS 磁盘权限**：若本机 Agent 程序或其配置位于外置磁盘，需在「系统设置 → 隐私与安全 → 文件与文件夹 → ScholarLite」开启「可移除的宗卷」，再点击「更新模型列表」。

### AI 回答中的交互可视化

可直接提问「用图比较这几个结果」「画出计算流程」或「用滑块解释参数如何影响结果」。回答会按需要将文字与交互图表、表格、SVG 机制示意和参数滑块组合展示；简短问题仍使用纯文字。

- 集成改编自 [Open Intelligent UI](https://github.com/thesysdev/open-intelligent-ui) 的论文相关组件与 OpenUI 1.0 本地渲染器，继续使用本机 Codex／Claude Code，无需云端专用 API Key。
- 支持柱状、折线、面积、饼图、环形与散点图，以及机制示意图和本地响应式参数滑块／选项控件。图表严格校验数据完整性，拒绝缺失或非数值数据，不将缺失值静默补零。
- 可视化组件仅在出现可视化回答时按需加载，自适应浅色与深色主题。滑块调整值在本地计算并在历史重开后保留；点击追问按钮会将当前控件值带入输入草稿。复制和存为笔记保留可读文字，聊天记录保存可重新渲染的源码。
- 修改可视化组件定义后可运行 `npm run generate:visual-prompt` 同步模型系统提示词；上游来源与 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 界面与交互体验

- **主题与材质**：支持浅色、深色和跟随系统。macOS 导航侧栏与阅读工具栏保留轻微原生通透材质（系统开启减少透明度或提高对比度时自动回退实色）；正文使用不透明纸面，AI／笔记／大纲面板与弹窗使用实底。
- **本地打包字体**：界面使用 Inter，侧栏使用 Schibsted Grotesk 与 Noto Sans SC，正文可选系统衬线或无衬线字体，离线完整可用（字体说明见 [renderer/src/assets/fonts/README.md](renderer/src/assets/fonts/README.md)，许可位于 `renderer/public/licenses/`）。
- **图片高清预览与并发渲染**：双击图表、算法或原稿公式进入预览，支持鼠标滚轮定点缩放、拖拽平移、`+`/`-` 缩放、方向键平移、`0` 适应窗口、`Esc` 关闭。重新打开文献时先显示缓存正文，图片与原页渲染共用两个并行槽位，当前可视区域优先、邻近区域预取。
- **面板与快捷键**：左右侧栏收放按钮固定在窗口两侧上角，收起面板保留正在编辑的草稿。常用快捷键：`⌘K` 聚焦书库搜索、`⌘,` 打开设置、`Esc` 逐级退出当前浮层／选区／阅读页。

---

## 目录结构

```text
electron/                        Electron 主进程（Node ≥ 22）
  main.ts                        窗口生命周期、slite:// 协议注册、安全策略与导航白名单
  preload.ts                     ContextBridge IPC 契约暴露
  ipc.ts                         文献、块、分类、笔记、进度、OCR、设置等主 IPC 路由
  db.ts                          node:sqlite 数据层（WAL、事务、多级分类树、迁移）
  reanchor.ts                    重新解析后的笔记唯一重锚定与歧义保留
  library-import.ts              Zotero（只读 WAL）与本地文件夹递归导入
  library-import-migration.ts    外部库多级分类树恢复与原子迁移
  library-import-ipc.ts          外部库发现与导入进度 IPC
  metadata.ts                    Crossref / arXiv 在线元数据查询
  pdf-metadata.ts                PDF 内嵌属性与首页期刊／会议／年份解析
  metadata-backfill.ts           首屏非阻塞后台元数据补全队列
  translate.ts                   多 Provider 并发翻译调度、重试退避与缓存校验
  translation-stream.ts          带段落 ID 的流式输出解析与局部恢复
  translation-ipc.ts             翻译流式进度与控制 IPC
  magpie.ts                      Magpie 网关模型目录与思考档位适配
  ocr.ts                         macOS Vision 本地文字 OCR 调用与二进制编译缓存
  formula-ocr.ts                 本地 Python pix2tex 公式图片 OCR 进程管理
  settings.ts                    原子文件写入（0600 权限）与设置校验
  paths.ts                       应用数据目录与托管 PDF 路径
  chat/                          本机 Agent AI 对话后端（service / store / catalog / codex / claude / agy 等）
renderer/src/                    React 19 渲染进程
  App.tsx                        顶层状态、文献切换、面板布局与全局快捷键
  reflow/                        PDF 版面重排引擎（v30）
    analyze.ts                   页面解析主流程、分栏、段落合并与阅读顺序
    regions.ts                   PDF 字形、绘图与图像几何提取及坐标变换
    math.ts                      行间公式组识别、唯一字形归属与正面积裁剪框生成
    inline-text.ts               行内上下标、嵌套脚本、积分与二维 mathPosition 构建
    formula-structure.ts         原生 PDF 二维公式结构转 LaTeX
    algorithms.ts                有框与显式无框算法伪代码区域识别
    figure-plates.ts             多图图版匹配与同行从左至右排序
    captions.ts / table-notes.ts 图注与表注识别及父子关系绑定
    front-matter.ts / portraits.ts / reading-roles.ts / references.ts
                                 首页作者／机构、文末传记／头像、出版页眉页脚与参考文献分类
    glyph-recovery.ts            PDF 字体编码恢复与未映射字形检测
    ocr.ts                       扫描页检测与 Vision OCR 映射
  components/                    Library / LibraryHome / Reader / FigureBlock / MathBlock /
                                 InlineText / NotesPanel / SettingsDialog / ImagePreview 等组件与样式
  chat/                          ChatPanel / ChatHistory / Markdown / VisualAnswer 及 visuals/ OpenUI 组件
  lib/                           pdf.ts（PDF.js 封装与按需裁图）、chinese-reflow.ts（流式中文调度）等
shared/                          主进程与渲染层共享类型与纯函数契约
  types.ts / chat-types.ts       核心数据结构与 IPC 类型定义
  reading-content.ts             阅读投影与可译内容判定策略
  reflow-validation.ts           重排输出入库前质量门校验
  translation-scripts.ts         翻译科学上下标与二维数学空间组编码／还原／校验
  collection-tree.ts / venue.ts  多级分类树运算与期刊／会议简称映射
  generated/                     自动生成的 OpenUI 可视化组件系统提示词
scripts/                         构建、开发启动、macOS 应用入口打包、公式 OCR 环境配置与迁移脚本
tests/                           38 个回归与集成测试脚本及 tests/fixtures/ 真实页面几何金标
docs/                            架构说明（docs/README.md）与专题调研／修复归档（docs/research/）
assets/                          应用图标资源（app-mark.png / app-icon.png / ScholarLite.icns）
```

应用运行数据目录：`~/Library/Application Support/ScholarLite/`（`library/` 存放托管 PDF，`library.db` 为 SQLite 数据库，`chat/` 存放对话配置与附件，`config.json` 存放界面与翻译配置）。

---

## 验证与测试

架构说明与历史调研见 [docs/README.md](docs/README.md)，各阶段详细验收记录见 [VALIDATION.md](VALIDATION.md)。存储与导入测试均使用隔离临时目录与临时 SQLite 数据库，不会修改用户真实书库。

```bash
# 1. 类型检查与生产构建
npm run typecheck
npm run build

# 2. 版面重排、公式归属、二维行内数学与字形恢复
node tests/reflow-regression.mjs
node tests/formula-groups.mjs
node tests/formula-structure.mjs
node tests/math-crop-ownership.mjs
node tests/inline-reflow.mjs
node tests/inline-integral.mjs
node tests/inline-text-render.mjs
node tests/reading-content.mjs
node tests/reading-regions.mjs
node tests/algorithm-portraits.mjs
node tests/source-text-fallback.mjs
node tests/crop-regression.mjs
node tests/reader-position.mjs
# 真实论文固定验收集（PDF 取自本机书库，缺失时 SKIP；dev/holdout/regression 分组见 fixture）
node tests/corpus-acceptance.mjs

# 3. 流式翻译、并发调度与二维数学空间结构保护
node tests/translation-spatial.mjs
node tests/chinese-reflow.mjs
node tests/translation-backend.mjs
node tests/translation-ipc.mjs
node tests/translation-protection.mjs
node tests/translation-script-cache.mjs
node tests/magpie-regression.mjs

# 4. 文献库、多级分类树、外部库导入、PDF 元数据与存储迁移
node tests/storage-regression.mjs
node tests/library-management.mjs
node tests/library-import.mjs
node tests/library-import-ipc.mjs
node tests/library-tree-migration.mjs
node tests/settings-regression.mjs
node scripts/test-pdf-metadata.mjs

# 5. 本机 Agent AI 对话、协议适配与 OpenUI 交互可视化
node tests/chat-backend.mjs
node tests/chat-models.mjs
node tests/chat-references.mjs
node tests/chat-clipboard.mjs
node tests/chat-visuals.mjs
node tests/visual-library.mjs
node tests/claude-protocol.mjs
node tests/agy-protocol.mjs
node tests/agy-environment.mjs

# 6. 本地文字 OCR 与公式图片 OCR（需 macOS Vision / 本地公式 OCR 环境）
node tests/ocr-native.mjs
node tests/ocr-reflow.mjs
# node tests/formula-ocr.mjs /path/to/formula.png

# 7. 可选：指定本地 PDF 样本输出块结构或执行双论文验收
# node tests/reflow-sample.mjs /absolute/path/to/paper.pdf /tmp/blocks.json
# node tests/conference-acceptance.mjs /path/to/isscc.pdf /path/to/iotj.pdf /path/to/iotj-before.json /tmp/conference-check
```

---

## 安全设定

`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、渲染层严格 CSP、禁止新窗口（外链通过系统浏览器打开）、禁止 `webview`、拒绝所有渲染层权限请求、页面导航仅允许 `slite://` 与开发期本地 dev server。

---

## 许可

MIT。PDF 解析依赖 `pdfjs-dist`（Apache-2.0）；AI 可视化组件与运行时声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；内置字体基于 SIL Open Font License 1.1（见 `renderer/public/licenses/`）。本项目不包含任何来自 Scholaread 的代码或资源。
