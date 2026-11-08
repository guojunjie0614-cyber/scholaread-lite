# 重排与本地 OCR 验证记录

2026-10-29，在本机 macOS / Electron 中验证当前 IoTJ Manuscript（11 页）。

## 实际论文

最终输出 203 个块，包含 16 个编号公式、6 张表、9 幅图、4 条独立表注及 17 条完整参考文献。

- 作者行顺序恢复；GLOBAL 开头的正文保持同一段。
- 左右栏及通栏区域按阅读顺序排列，首页脚注移至整页正文后。
- 公式（1）保持完整且位于 where 解释之前；公式编号不重复显示。
- TABLE II 包括全部数据、最后一行与底线。
- TABLE VI 的 ∗ / † / ‡ 三条注释绑定到该表；首条跨行合并。TABLE IV 的无标记说明也单独归为表注。
- 表注按小于正文的字号紧排，保留 H₁、P_FA 与 10⁻³ 的脚本语义；其后的 packing reduces 正文及 C. PPA Evaluation 标题保持独立。
- 已在真实 Electron 界面检查用户截图所指 TABLE VI 区域，三条表注、上下标和正文层次均正常。
- 列表和参考文献续行合并；正文下标 0 不再因页边数字规则被删除。
- 已生成并检查全部图、表、公式裁图。重点放大检查公式（1）、（2）、（7）、（12）、（13）及表 II。
- Electron 实际显示已检查章节层级、大纲跳转、公式（1）、表 II、公式（2）的原稿与排版预览、图 5。

离线 pdf.js + @napi-rs/canvas 渲染图 5 时缺少部分底边，连完整原页也如此；Poppler 和实际 Electron canvas 显示完整。此差异属于离线验证渲染工具，当前裁剪框已覆盖图形底边，未为此扩大或修改截图。

## OCR 与公式排版

文字 OCR：macOS Vision 的英文、简体中文真实图片测试通过；另用仅含图片的 PDF 验证了页面渲染 → IPC 对应识别接口 → 位置映射 → 正文重排的完整链路，并检查单词空格与阅读顺序。

公式识别采用原生结构优先：根据 PDF 字形、字体、基线、分数线恢复上下标、叠加重音、求和限、分式、伸缩括号、cases 与 aligned。不能完整恢复的结构不产生原生候选，继续使用本地 pix2tex 图片 OCR，默认保留原稿。

重点公式（7）、（10）、（11）、（12）、（13）、（16）已完成原图与 KaTeX 的逐项、实际渲染对照，并保存为已核对排版：

- （7）：两个分支、条件中的 or / and、≠ 与 ≥ 正确。
- （10）、（11）：两行表达式、嵌套分数、ceil / floor 和下标完整；括号随分数伸缩。
- （12）：两行均保留；第一组上下限 s=0、N_s−1，第二组 e=0、N_e−1 互不串用；hat(dot(f)) 保留。
- （13）：两个分支及求和上下限完整，分支中的求和使用 displaystyle。
- （16）：两行计数公式完整，最后一项为 N_{dot(f)}；修正旧识别结果的 N_j。
- 同时检查无等号续行、左式独占首行的对齐、花体 H 字体、合法括号数字和希腊字形变体，避免把内容或字体区别抹掉。

当前论文式（1）、（2）仍有正确候选；式（15）因无法确定一个下标的归属而保守回退。纯图片 pix2tex 对复杂分段/多行结构仍可能误识别，本轮对数字 PDF 的改进不等于扫描件 OCR 已达到同样精度。

对照页为 `.validation/formula-review.html`，原图和公式字体均内嵌，可直接本地打开。对应输入块快照为 `.validation/iotj-blocks-complex.json`。被采用公式的前值保存在 `.validation/reviewed-formulas-before.json`；保存通过应用的来源校验接口，未把手工转录的期望式喂给识别器。

## 已执行检查

- `npm run typecheck`、`npm run build` 通过。
- `node tests/reflow-regression.mjs`：16 项版面回归通过，覆盖双栏公式、左右栏排序、通栏分区、图注保护、三线表、旋转坐标、列表/参考文献续行、脚注、扫描页回退、失败页拒绝残缺保存。
- `node tests/formula-structure.mjs /absolute/path/to/paper.pdf`：20 项结构及真实论文转录对照检查通过。
- `node tests/storage-regression.mjs`：schema 迁移、元数据持久化、事务回滚、笔记唯一重锚/歧义保留、已校对公式保留、过期 OCR 拒绝写入复用 ID、表注关系及 textRuns 持久化、表注批注重锚、未核对机器草稿更新，通过。
- `node tests/crop-regression.mjs`：文档隔离、并发缓存去重、失败重试、非法区域拒绝，通过。
- `node tests/ocr-native.mjs`、`node tests/ocr-reflow.mjs`：真实文字识别及扫描 PDF 重排，通过。
- `node tests/formula-ocr.mjs /tmp/scholarlite-formula-equation2.png`：真实模型请求、串行队列、确定性输出、停止后重启与非法输入检查，通过。

当前样本块数据和裁图保存在 `.validation/`；本轮开始前的数据库备份为 `.validation/library-before-complex.db`，上一轮备份为 `.validation/library-before.db`。测试不依赖该私有论文作为公共回归 fixture，`reflow-sample.mjs` 接受调用方提供的 PDF 路径。

## 会议论文图版提取完成验收（2026-10-29）

接续“优化论文 OCR 与重排”对话，最终重排引擎版本为 5。样本为 ISSCC 2025 论文 14.5（三页）。

- 完整提取 7 幅图和 7 条独立图注，图号为 14.5.1–14.5.7；第二页六图按行从左至右，第三页为第七图。图注紧随对应图片并持久化父子关系。
- 独立读取原 PDF 的位图绘制范围与 clipping 范围，逐图检查完整覆盖、无邻格混入、无图注字形混入。图 14.5.6 保留比较表及两张曲线图，图 14.5.7 保留芯片照片、散点图和汇总表。
- 第三页保留 14 条完整参考文献；正文中的 Figure 引用保持正文；空白图版单元没有生成假图片。
- 修复两项收尾时发现的问题：普通双栏论文的单栏位图不再将右栏上半段提前；小字号章节标题不再被合入相邻图注。图和图注作为原子单元参与阅读排序，对齐的同排图版按从左至右排列。
- 修复浮点裁图范围到整数画布像素的映射，避免 ceil 留白带入边界外图注像素。

### IoTJ 回归与真实书库

独立验收逐块比较改动前后全部 203 个块，文字、类型、顺序、裁剪范围、公式结构和四条表注的上下标及父表关系一致。真实应用已将两篇论文升级保存为版本 5；另与本轮启动前的数据库备份比较，IoTJ 的全部 203 个块内容、裁剪、公式及脚本字段一致，7 个已确认公式排版保留。

### 本轮有效检查

- `npm run typecheck`、`npm run build` 通过。
- `node tests/reflow-regression.mjs`：23 项通过，包括新增单栏位图顺序和图注邻接标题用例。
- `node tests/storage-regression.mjs`、`node tests/crop-regression.mjs` 通过。
- `node tests/conference-acceptance.mjs`：25 项真实双论文验收通过。报告位于 `.validation/conference-implementation/acceptance/report.json`。
- 对照原页标框和七图总览逐图检查裁剪边界；在真实 Electron 中检查图版、图注、图 14.5.6 复合图、IoTJ TABLE VI 表注和多行公式（12）。完成论文切换及重新打开后的缓存检查。另在 1040×680 渲染区域检查图版缩放，正文区域没有水平溢出，工具栏操作可见。

验收输出中 pdf.js 离线渲染器对页边授权文字的 Helvetica path 有警告；七幅图为原生位图，原始范围验收与实际 Electron 裁图均正常。

证据：`.validation/conference-implementation/figures-contact.png` 为七图总览，`overlay-2.png` / `overlay-3.png` 为原页范围对照；本轮实际界面截图和构建日志在 `.validation/conference-completion/`。本轮启动前书库备份为 `.validation/conference-completion/library-before.db`。


## IC Agent Harness 风格界面与文献管理完成验收（2026-10-29）

接续“续完论文 OCR 重排优化”的最后一轮 UI 改造。复用 IC Agent Harness 的浅深色令牌、本地字体、侧栏收放几何和菜单尺度，统一书库首页、三栏阅读区、设置、笔记与公式编辑。

### 功能与收尾修复

- 侧栏右键及「更多操作」提供打开、编辑文献信息与标签、Finder 定位、导出笔记及删除确认；搜索支持标签、作者、来源及 DOI，支持最近阅读、最近添加和标题排序。
- 设置分为外观、阅读排版、翻译服务，补齐 DeepL Free／Pro 接口地址；保存失败保留弹层和错误，写文件及 rename 成功后才更新后台配置。
- 笔记支持高亮后追加批注、保存、取消、删除确认；原页模式的笔记和大纲跳转按 PDF 页定位，重排模式按内容块定位。
- 修正整页翻译失败仍显示成功的错误；成功、缓存命中与失败各有真实反馈。
- 导入对话框改为单选，与当前单篇导入接口一致，避免多选后静默忽略其余文件。

### 证据与范围

上一轮保留的实际 Electron 验收覆盖导入临时 PDF、编辑标题作者年份与标签、标签搜索、笔记新建/编辑/导出、删除取消与确认。测试文献删除后，书库记录和副本被移除，最初的导入文件保留。相关截图为 `.validation/ui-review/paper-edit.png`、`note-saved.png`、`delete-confirmation.png`，导出文件为 `exported-notes.md`。

本轮在同一隔离 profile 的最终构建中补验：

- 原页大纲从第 1 页跳至 REFERENCES 所在第 11 页；笔记引用从末页回到对应首页。重排与原页切换、公式原稿/LaTeX 编辑预览正常。
- 未配置 API Key 时显示真实翻译错误，不再覆盖成功；Echo 离线整页翻译产生 12 段译文。没有向远程服务发送论文。
- DeepL 接口地址保存后重新打开保持一致。制造临时配置写入失败，弹层保留错误、主题保持原值；解除故障后保存成功。
- 高亮追加批注、编辑取消保留前值；删除取消保留笔记。菜单支持方向键、End、Escape，窗口边缘自动移入视区；无结果搜索和标题排序正常。
- 实际检查空书库、浅深色首页、阅读、设置、笔记、公式、双侧栏收起；1040×680 渲染区域和 24px 正文没有页面横向溢出，工具栏与面板控件未被遮挡。此前 1480×940 与 1040×680 原生窗口验收截图继续有效。本轮 renderer 未出现 pageerror。

最终构建 `npm run typecheck`、`npm run build` 通过，构建记录为 `.validation/ui-review/completion-build.log`。
`node tests/library-management.mjs` 通过，覆盖真实 IPC 文献副本导入、元数据/标签、Finder 目标、笔记导出、级联删除及原文件保留。
新增 `node tests/settings-regression.mjs` 通过，覆盖真实文件写入失败、rename 失败、后台配置不变、恢复保存和新实例重新读取。
重排引擎未在本轮修改，前述双论文、公式与裁图有效验收继续沿用。

本轮截图使用 `.validation/ui-review/completion-*.png`。测试 profile 与用户书库分离，隔离验收进程在结束后关闭。

交付时已正常退出旧运行实例并启动最终构建。真实书库 3 篇文献正常加载，IoTJ Manuscript 打开成功并显示 16 个公式块；应用保留打开供继续阅读。


## 分类书库、原生侧栏与中文重排交付（2026-10-29）

### 文献库与桌面壳

主书库铺满内容区域，默认紧凑列表，支持自适应卡片、搜索范围、阅读状态、排序和详情。分类采用独立表与多对多关系，两层分类、批量加入/移出/标签/状态及拖放归类均已接入。父分类包含子分类时，移出动作明确包含子级，其他分类归属不变。删除分类保留文献、PDF、笔记；导入目标已删除时立即回退未分类。左侧最近阅读仅取成功打开的最近 10 篇。

参考 IC Agent Harness 接入 macOS 原生 menu vibrancy，renderer 根层透明、正文不透明，减少透明度与高对比有实色回退。侧栏收放控件放在全部拖拽区域之后，修复原生鼠标命中。右侧控件固定窗口右上，去除笔记面板重复导出，收起面板保留草稿。

用隔离的 24 篇书库（两篇真实样本及复制 PDF 的示例元数据）实际验收：创建一级/子分类、两篇同时加入两个分类、从父分类移出并保留另一归属、拖入分类、批量加标签/状态筛选、搜索当前分类与完整书库、卡片切换、删除分类后文献保留、导入目标回退。全库搜索找到不在最近十篇中的 Study 20；重新启动后分类关系和标签仍正确。默认 1480×940 列表约可见 12 行，1040×680 控件无横向溢出；检查浅深色列表/卡片和阅读布局。

最终真实窗口用 CUA **坐标鼠标点击**验收（Retina 截图像素坐标）：左侧 (196,50) 连续收起、展开；右侧 (2900,50) 连续收起、展开。不是 AX 点击或 DOM click 替代原生命中检查。右按钮 renderer 坐标始终为 x=1436,y=11,w=28,h=28，阅读导出按钮数量为 1；独立笔记草稿在收起后恢复。真实 native appearance 返回 darwin/nativeVibrancy=true/reducedTransparency=false，已查看原生截图中的材质与不透明正文分层。未更改用户系统的减透明设置；回退路径由代码与 CSS 媒体规则检查。

### 中文原位重排

「切换中文」分批准备全文标题、正文、图注、表注与参考文献，完整就绪后原位替换，可切回原文，不再渲染上下双语。图表截图和行间公式保留原位。停止不再提交后续批次；失败保留原文，成功批次可用于重试。切换论文和提供方后旧结果不会进入新视图。

带 textRuns 的 H₁、P_FA、10⁻³ 使用受限 sub/sup 标记往返，并检查类型、顺序和内容；后端在写缓存前校验，旧坏缓存可以重新请求。普通 HTML 始终按文本转义。中文笔记保留译文摘录与段落定位，start/end offset=null，不产生错误的原文高亮。

实际 UI 验收使用 `.validation/library-redesign/translation-stub.cjs` 的**本地固定中文测试输出**，仅在隔离 entry.cjs 加载；正常应用未注入该 fixture。检查全文替换、没有旧 .tr 双语块、16 个公式块保留、表注 sub 为 1/FA、sup 为 −3，中文笔记定位与 null offsets、失败/重试/停止、切换论文后迟到结果不污染。未调用付费或远程翻译服务，未据此评价真实翻译质量。

### 会议论文与真实库

重排版本为 6。FP8 段中换行的句末 [13]. 按段落、参考章节和几何连续性判断，合并回正文；带句点编号的真实参考条目及下一页续参考保持 ref。出版页脚与竖排版权水印按页边位置和出版特征剔除。

会议论文 51→46 块，7 幅图、7 条图注、14 条参考文献保留。FP8 正文合并少 1 块，4 个出版页脚块移除；正文内水印移除不改变块数。IoTJ 全部 203 块语义、文字、顺序、裁图、公式结构、表注逐块与基线一致。

真实应用已正常重启至最终构建，打开两篇论文完成版本 6 自动缓存保存：共 249 块。与激活前快照比较，论文和笔记数量一致，8 个已确认公式的 LaTeX 与确认状态保留。交付时回到主书库，未添加测试分类或测试译文到用户库。

### 有效检查与证据

- `npm run typecheck`、`npm run build` 通过，最终构建日志 `library-redesign/build.log`。
- `node tests/library-management.mjs`、`node tests/storage-regression.mjs` 通过，含增量迁移、分类多归属、第二次写入故障时批量回滚、父分类范围移出、原文件保留、最近十篇。
- `node tests/reflow-regression.mjs`：29 项；真实双论文 `tests/conference-acceptance.mjs`：27 项通过。
- `node tests/chinese-reflow.mjs`、`node tests/translation-script-cache.mjs` 通过，覆盖上下标语义、缓存匹配/坏缓存恢复、缺段拒绝、取消和重试。
- 最终 UI 验收未出现 renderer pageerror；pdf.js 的既有 TT 字体警告不影响原图与重排验收。

本轮完整资料位于 `.validation/library-redesign/`：`HANDOFF.md`、`reader-shell-notes.md`、`reflow-notes.md` 为各模块说明；`reflow-acceptance/report.json` 为真实论文机器报告；`library-list*.png`、`library-grid-dark.png`、`chinese-table-notes.png`、`chinese-dark.png`、`conference-body-small.png`、`conference-references-end.png` 为实际截图。中文截图为上述固定测试输出。

用户库快照为 `user-library-before.db` 与正式激活前的 `user-library-before-activation.db`；`activation-result.json` 记录激活验证。隔离测试进程已关闭，日常阅读器保持运行。


### 最后配置入口校验

激活时只读取当前提供方标识及配置是否存在的派生状态，确认日常配置为 Echo 调试回显。中文切换新增保护：Echo 保持原文、不给出成功、不提交翻译请求，持久提示并提供「设置翻译服务」直达 translation 页。正常设置入口与 ⌘, 仍默认 appearance 页；未修改用户配置或 Echo 调试 API。

追加改动的 `npm run typecheck` 与 renderer 构建通过（`final-renderer-build.log`）。最终真实应用刷新后实际点击中文按钮，确认保持原文并显示 Echo 提示；点击设置入口直达翻译页，提供方仍为 echo，取消后回到主书库。生产入口不加载隔离译文 fixture。


## 2026-10-29 书库控件收紧

按确认方案统一黑白灰控件：分类弹窗实际宽度420px、移除分区横线，创建/保存及禁用态中性；分类位置、阅读状态、筛选、排序、搜索范围、导入分类使用共享浮层菜单。书库数量仅在标题旁显示；导入默认当前分类，多选操作替换搜索工具栏，全选在表头，详情入口合入更多操作。删除双击教学和缺失作者占位。

- `npm run typecheck`、`npm run build:renderer`通过，无新依赖。
- 隔离24篇Electron书库实际交互：筛选/排序往返、当前分类与全库搜索、空结果、全选和批量状态写入往返、标签写入、分类弹窗、详情迁移均通过。
- 导入IPC以隔离实例取消回包检查参数，确认当前分类→临时选择子分类→仍默认当前分类；未改系统文件选择器。
- 修复工具栏替换后快捷搜索焦点时序，实际验证同分类及跨分类的Command-K均聚焦搜索框。
- 共享菜单组件检查通过方向键/Home/End、Enter、Escape/Tab及焦点恢复；弹窗内Escape先关闭菜单，不关闭弹窗；420px弹窗宽度及紧凑视口边界通过。
- 目视检查1480×940、1040×680的列表/卡片、批量工具栏、浅深色菜单及分类弹窗。主要控件无水平溢出；截图位于`.validation/library-redesign/polish-*.png`，组件证据在`.validation/ui-polish/`。
- 本轮不改变存储、重排、翻译逻辑，沿用此前对应有效测试结果。

## 2026-10-29 算法整块保留与作者头像过滤

引擎版本7。TCAD 14页样本第6页算法在分栏前识别为独立区域，PDF三倍裁图保留标题、输入输出和1–18行；行号不再串入旁栏正文。第13–14页10张作者照片隐藏，作者简介文字与37条参考文献逐字按序保留。样本258→236块；所有科研图表保留。IoTJ203块及ISSCC46块语义与裁图逐块不变。

支持具有完整上下边线及输入输出/控制结构证据的同页算法；无边框、缺结束边界及跨页算法不自动裁切。额外复现并修复了缺底线时误用后面同宽横线吞入正文的问题；后续正文、章节、图注、表题、另一算法标题5个反例通过。

`algorithm`使用既有块存储契约；关闭图表和切换中文时仍保留原算法图片，区域笔记可定位；旧算法文本笔记迁移到区域锚点并清除字符偏移。原PDF未改变。

证据在`.validation/algorithm-portraits/`：专项回归、29项既有重排检查、中文重排、存储回归、typecheck/build通过；`report.json`记录11项真实PDF验收，`algorithm-crop.png`为已目视裁图。最终窗口已重启至新构建，目标论文重新解析为236个版本7块；`activation-result.json`确认3篇文献、笔记数量及8个人工确认公式保留。当前窗口停在第6页算法。激活前一致性备份为`user-library-before-v7.db`。

整体UI仅审查未继续改版，覆盖书库/阅读/公式/笔记/设置、浅深色和1040×680小窗口；对照已安装Kimi Code及IC Agent壳。建议与实际截图索引在`.validation/ui-review-20261029/REVIEW.md`，优先设置页、笔记编辑、公式操作，再收紧卡片和跳页/大纲。

## 2026-10-29 五处 UI 对齐收尾

继续「接手并完成最近对话」最后获授权的UI实施：设置使用紧凑分组行、主题分段与共享菜单，保留显式保存；笔记弹窗及列表减轻边框并统一中性按钮；公式操作收进悬停/聚焦可见的共享菜单，处理/错误/待确认仍显式；卡片操作移到右上，去底部操作区、统一标题区域与元数据基线；页码可输入或菜单选择，重新解析收更多，大纲去重复文献标题并标记当前章节。

移除旧settings-notes.css和废弃公式工具/原生页码样式，独立settings.css、notes.css与reader-controls.css管理各自界面。README同步新入口。typecheck、完整build通过；真实Electron独立数据库副本验收设置保存/取消、服务字段切换、卡片菜单多选、笔记增删改定位、公式结构识别/校对/采用/回原稿、页码输入边界及大纲原页/重排联动。启动1480×940浅色、1040×680深色实看通过；完整截图索引与结果在`.validation/ui-polish-20261029/QA.md`。日常应用已打开最新构建。


## 2026-10-30 多级分类树、外部文献库导入与后台元数据补全

- **多级分类树与数据迁移**：解除原两层分类限制，支持任意深度父子分类、防环校验、父级去重汇总与名称含斜杠的独立分类标识。从 Zotero 源数据库按稳定 `collectionKey` 与父键恢复真实层级树，移除旧自动来源包裹层，保留全部文献 ID、PDF 副本、笔记、聊天与阅读进度。
- **Zotero 与本地文件夹导入**：只读读取 Zotero SQLite（含 WAL），支持默认与自定义数据目录的托管附件及链接附件（`attachments:` 基础目录解析），保留同一文献的多个 PDF 附件；文件夹递归导入支持识别 EndNote `.Data/PDF` 结构。重复导入遵循零覆盖契约，仅补新文献或缺失托管文件，不恢复用户已移除的分类和标签。
- **首屏非阻塞与后台元数据回填**：`papers:list` 立即返回数据库已有文献，后台增量提取期刊／会议简称（如 `TCAD`、`ISSCC`、`IoT J.`）与真实出版年份并推送刷新，持久化无结果状态避免每次启动重复解析。
- **有效检查**：`node tests/library-import.mjs`、`node tests/library-import-ipc.mjs`、`node tests/library-tree-migration.mjs`、`node scripts/test-pdf-metadata.mjs`（11 项）全部通过。


## 2026-10-30 本机 Agent AI 对话与 OpenUI 交互式可视化

- **本机 Agent 接入**：右侧面板新增「AI」标签（与「笔记」「大纲」等宽分布），主进程通过适配器连接本机安装的 Codex App Server 与 Claude Code CLI（`stream-json`），动态读取可用模型与思考档位，提供自定义模型与 Default 档位恢复通道。Antigravity（`agy`）保留协议与环境适配代码，待上游 CLI 工具集限制确认后开放。
- **上下文、引用与会话分支**：支持重排正文与原页透明文字层选区右键「发送给 AI 解读」「引用到 AI」，以及图表／公式／原页截图附件（最多 4 张、单张 10 MB）。消息、附件与来源锚点存储在应用 SQLite，支持流式停止、消息编辑创建分支、重新生成、历史重命名与 8 秒撤销删除。
- **OpenUI 交互式可视化**：集成 Open Intelligent UI 论文相关组件与 OpenUI 1.0 本地渲染器，按需懒加载柱状、折线、面积、饼图、环形、散点图、SVG 机制示意与参数滑块控件，严格拒绝缺失或非数值图表数据。
- **有效检查**：`node tests/chat-backend.mjs`、`node tests/chat-models.mjs`、`node tests/chat-references.mjs`、`node tests/chat-clipboard.mjs`、`node tests/chat-visuals.mjs`、`node tests/visual-library.mjs`、`node tests/claude-protocol.mjs`、`node tests/agy-protocol.mjs`、`node tests/agy-environment.mjs` 全部通过。


## 2026-10-30 重排引擎 v27–v28：完整区域归属、二维行内数学与分段流式翻译

### 重排修复（Engine v27 → v28）

- **公式唯一归属与完整裁片**：先确定公式组及跨栏唯一字形归属，再求包围全部墨迹的正面积裁剪框；英文下标不再被误判为普通正文而截断公式。相连编号公式合并为完整原稿区域，旧单式人工校对归档保存在 `formulaReviews` 中。
- **行内二维数学与大运算符**：同基字上下标、嵌套下标、重音、圈号及扩展字体积分（`CMEX`/`MTEX`）通过 `mathPosition` 保留二维相对位置，同时保持 `Block.text` 规范字符顺序与笔记高亮偏移一致。
- **无框算法、参考文献续行与字形恢复**：支持带显式标题、连续行号（含冒号格式）与输入输出的无框伪代码整块保留；跨栏／跨页参考文献续行及期刊缩写（如 `J.`）不再误判为章节标题；PDF 字体编码恢复 `squaresolid`（`■`）与点号等号（`≐`），无法映射的局部未知字形仅对受影响来源行回退原稿裁片并保持正文字号。
- **作者与出版附属内容过滤**：统一识别并隐藏首页作者／机构、文末传记（含 `Mr.`、`Dr.-Ing.` 等头衔及获奖／任职续段）、相邻头像及重复出版页眉页脚，保留资助说明、技术附录与参考文献。
- **入库前质量门**：保存前校验裁剪框正面积、文字偏移一致性与空间组连续性，拒绝非法块覆盖既有缓存。

### 流式翻译与数学空间结构保护

- **优先级并发调度与 Magpie 网关支持**：新增 Magpie 网关动态模型与思考档位接入；支持 1–16 并发槽位，按划词、当前可见正文、同页缺口、邻页预取排序，完成校验一段立即原位显示一段。
- **二维数学占位符往返校验**：将内联变量、上下标与连续 `mathPosition` 空间组整体编码保护，译文返回后完整还原几何偏移与样式；缺失、重复或乱序占位符自动触发单段恢复，坏 source 或坏缓存隔离在单段内，不阻塞同批其余段落。
- **准确页面进度**：按当前页真实可译文本块统计“本页已译 X/Y 个文本块（缓存恢复 M · 本次完成 N）”。

### 有效检查与证据

- `npm run typecheck`、`npm run build` 通过。
- 重排与公式／字形回归：`node tests/reflow-regression.mjs`（43 项）、`node tests/formula-groups.mjs`（SWCS p3/p4、ReFFT p3/p8/p13 原 glyph 金标）、`node tests/inline-reflow.mjs`、`node tests/inline-integral.mjs`、`node tests/inline-text-render.mjs`、`node tests/reading-content.mjs`、`node tests/reading-regions.mjs`、`node tests/algorithm-portraits.mjs`、`node tests/source-text-fallback.mjs` 全部通过。
- 翻译与数学结构回归：`node tests/translation-spatial.mjs`、`node tests/chinese-reflow.mjs`、`node tests/translation-backend.mjs`、`node tests/translation-ipc.mjs`、`node tests/translation-protection.mjs`、`node tests/translation-script-cache.mjs`、`node tests/magpie-regression.mjs` 全部通过。
- 详细诊断与交付记录见 [`docs/research/pdf-reflow-fix-2026-10-30.md`](docs/research/pdf-reflow-fix-2026-10-30.md) 与 [`docs/research/translation-fix-2026-10-30.md`](docs/research/translation-fix-2026-10-30.md)。

