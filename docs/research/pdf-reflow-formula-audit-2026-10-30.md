# PDF 重排公式链路审计：先确定字形归属，再生成裁片

日期：2026-10-30。阶段：只读诊断与方案选择；产品源码、用户数据库均未修改。

## 结论

截图中的 cases／求和公式截半，是**当前解析器直接生成错误区域和错误文字归属**，不是仅有旧缓存、缩放或 CSS 问题。当前源码重新解析 SWCS 原 PDF，精确得到截图中的 `comb,0 comb,i−1`、`sum-weight,i weight,i` 独立正文，以及第 4 页两个负高度裁片。

首选方向是把现有“按行判 prose → 扩公式 → 用 prose 截裁片 → 再补所有权”的流程，改成“保留字形与绘图证据 → 建立公式／正文归属 → 解决相邻区域冲突 → 从已确定归属生成裁片”。PDF.js 的读取与裁图能力可以保留；本次没有证据要求更换它。仅扩大 padding、降低词数阈值或升级公式 OCR，都不能完整修复这条链路。

## 实际复现与证据位置

源码根目录：`./`，`REFLOW_ENGINE_VERSION = 25`。

读取了两篇实际文献，使用现有 `tests/reflow-sample.mjs` 调用当前 `analyzeDocument`，没有写书库：

- SWCS：`~/Library/Application Support/ScholarLite/library/31393279-7324-4107-8e32-e0d47be431f7.pdf`，6 页，252 个输出块。
- ReFFT：`~/Library/Application Support/ScholarLite/library/983273e4-a9e0-4ee5-be1e-a3e65e7f9103.pdf`，15 页，283 个输出块。其非公式问题由主审计使用同一份输出分析。

证据目录：`.work/reflow-audit-20261030/formula-audit/`。

- `swcs-current-blocks.json`、`refft-current-blocks.json`：当前源码全篇输出。
- `swcs-page3-geometry.json`、`swcs-page4-geometry.json`：同页原始字形、公式检测实际输入、栏边界、候选公式及基线行。
- `baseline-findings.json`、`probe.log`：真实单页与最小构造样例的失败断言。
- `counterfactual.json`：只改变内存中源码副本的一项判定后的结果；不是产品修复。
- `eq8-original.png`、`eq8-current.png`、`eq13-original.png`、`eq13-current.png`：同一 PDF 原区域与当前算法裁片。已逐张查看，截半与用户截图一致。

可重复的红灯命令（在源码根目录运行）：

```sh
node .work/reflow-audit-20261030/formula-audit/probe.mjs
```

实跑退出码为 1：`AssertionError: Formula ownership/crop acceptance failed`。该探针复制源码到自己的诊断目录进行打包，只读取 SWCS 第 3、4 页，并断言公式标签不泄漏为正文、裁片正高度，以及一个英语下标小样例的字形归属和裁切完整性。单次约 1 秒。

## P1：英语公式下标被误判为正文，又反向裁掉公式本体

**确定根因。**

代码链路：

1. [math.ts:40–61](../../renderer/src/reflow/math.ts#L40) 先按很窄的 baseline 容差把字形分行。下标自然成为独立行。`plain.match(/[A-Za-z]{3,}/g)` 按英语词数计数，再用数学字体／数学符号的宽度占比决定 `row.prose`；没有先确定下标所依附的主符号。
2. [math.ts:153–180](../../renderer/src/reflow/math.ts#L153) 从公式编号寻找种子，再按上下行扩张；`next.prose` 是硬停止条件。
3. [math.ts:105–113](../../renderer/src/reflow/math.ts#L105) 将未选入的 prose 行作为裁片上、下边界，按其字形 top/bottom 进一步收紧裁片。下标虽然 baseline 较低，其字形 top 往往高于公式主行 baseline，于是直接切掉主行下半部分。
4. [math.ts:119–127](../../renderer/src/reflow/math.ts#L119) 的补归属逻辑显式跳过 prose，无法救回误判的下标。
5. [analyze.ts:645–647](../../renderer/src/reflow/analyze.ts#L645) 仅从普通文字中扣除 `equationItems`，这些未归属下标因此继续生成正文段落。

### 同页实际数值

| 对象 | 被误判的下标行 | 误判理由 | 公式主行 baseline | 当前 crop bottom |
|---|---|---|---:|---:|
| SWCS p3 (8) | `comb , 0 comb ,i − 1`，baseline 323.39 | 两个正文体 `comb`，math ratio 0.412，字号 6.97 | 319.73 | 316.47132 |
| SWCS p3 (13) | `sum-weight ,i weight ,i`，baseline 717.00 | `sum-weight` 被拆成两个词，再加 `weight`；ratio 0.166，字号 6.97 | 714.08 | 710.960044 |
| SWCS p3 (14) | `weight ,i [ t ] weight weight , 0`，baseline 86.91 | 多个正文体 `weight`，ratio 0.244 | 84.16 | 81.040044 |

上述英语下标使用 `NimbusRomNo9L-Regu`，在原公式中完全合法，却被当作“普通英文段落”的证据。`(8)` 被截掉的下半部分随后与 `(9)` 混在另一裁片；`(13)` 的下限成为另一无编号公式片段。

最小构造样例同样失败：主行 `w = w (13)`，下一基线放 `sum-weight`、`weight` 两个 7pt 下标。检测器输出 `y1=94.86`，但主行 baseline 为 100；下标均未归属，还生成了错误但无 warning 的 `nativeLatex: "w = w"`。因此症状不依赖该 PDF 的扫描、字体损坏或 UI 状态。

### 单变量反事实验证

只在临时模块中要求“存在正文字号的普通字词”后才能把行判为 prose，其他逻辑不变：

- `(8)`、`(13)`、`(14)` 三条目标下标行全部进入公式所有权；
- p4 两个负高度裁片变为零；
- 但 p3 产生 **33 个重复归属字形**，主要在 `(8)/(9)`、`(14)/(15)` 之间。

这既确认 prose 误判是此次故障的直接原因，也否定了“改这一条阈值就可以交付”的方案。

## P1：检测器允许生成负高度区域，错误拖到图片加载阶段才暴露

**确定根因，与前述误分类存在直接因果关系。**

SWCS p4 当前输出：

| 公式 | crop `[x0,y0,x1,y1]` | 高度 |
|---|---|---:|
| 无编号 `∂x i + 1` | `[177.88,184.1134,292.7925444,183.792822]` | −0.320578 pt |
| `(28)` | `[318.82,494.2434,568.528358,489.9813200000001]` | −4.26208 pt |

`(28)` 上方 `weight-sig` 行和下方 `noi,Nnoi−i` 行被判 prose。上方行还混入伸缩大括号字形，其估计 bottom 为 493.0434；加上 1.2 安全间距后得到 `topLimit=494.2434`。下方下标行的最小 top 减 1.2 得到 `bottomLimit=489.98132`。边界已互相矛盾。

[math.ts:110–113、138–150](../../renderer/src/reflow/math.ts#L110) 没有把此矛盾反馈给区域识别；仍输出成功公式块。[analyze.ts:635–644](../../renderer/src/reflow/analyze.ts#L635) 随后持有该无效 crop。最终 [pdf.ts:184–185](../../renderer/src/lib/pdf.ts#L184) 正确拒绝它，UI 才显示“裁剪区域或缩放比例无效”。

应在区域判定层恢复完整、有效的来源区域，或明确降级为可见的完整来源区域。仅给 `cropBottom` 强行加最小高度，会把可定位的错误变成静默缺内容。

## P2：区域所有权由裁片反推，无法稳定处理相邻公式

**结构缺陷已由源码与反事实重放确认；33 字形重复是诊断变体结果，不是当前 p3 的原始统计。**

[math.ts:119–128](../../renderer/src/reflow/math.ts#L119) 通过“中心落在现有 crop 内”补归属，然后继续扩 crop。这是循环依赖：不准确裁片反过来决定语义归属，且补归属不排除下一公式编号。上方公式一旦扩过下方公式，后者可被吸入。

虽然 [math.ts:168–169](../../renderer/src/reflow/math.ts#L168) 在按行扩张时挡住其他编号，此保护没有覆盖后续补归属步骤。[math.ts:179](../../renderer/src/reflow/math.ts#L179) 也只丢弃“整行都已 claimed”的行，部分已 claimed 的行仍会整体重用。

此外，`claimed` 在每个 column 内单独创建，列范围还各外扩 1 pt，跨栏没有最终唯一所有者校验（[math.ts:82–89](../../renderer/src/reflow/math.ts#L82)）。当前 p4 已有一个同源 `P` 字形（x=303.84, y=729.35）同时属于一个无编号片段和 `(30)`。

伸缩字体还有统一 `descent=-1.8` 的估计范围（[analyze.ts:443–447](../../renderer/src/reflow/analyze.ts#L443)），不等同逐个伸缩组件的实际墨迹范围。其与 padding 的相互作用需要在最终裁片阶段检查；本次未将所有 glyph bbox 越界都等同于可见墨迹裁断。

## P2：原生 LaTeX 的“无 warning”不代表原公式完整

**已确定。** `restoreFormula` 只接收已选入的 `bodyItems`（[math.ts:129–137](../../renderer/src/reflow/math.ts#L129)），不会看到此前被丢到正文的下标或另一半公式。它能报告收到的未知字形，却无从报告没有收到的内容。

SWCS `(8)` 当前有 `nativeLatex` 且无 `structureWarnings`，但第二分支的 `if 1 ≤ i ≤ n_comb − 1` 不在该输入中，结果把分支内逗号后的余项误作 cases 条件。上面的最小样例则直接把 `w_sum-weight = w_weight` 变成 `w = w`。

`MathBlock` 的识别操作会优先选择该 `nativeLatex`，跳过图片 OCR（[MathBlock.tsx:44–51](../../renderer/src/components/MathBlock.tsx#L44)）。当前仍要求用户确认后才替换原图，这一点应保留；但候选生成必须以完整区域和可检查的 token coverage 为前置条件。KaTeX 语法可渲染不是数学内容完整性的判据。

## 行内数学：能处理简单样式，缺少表达二维结构的模型

**确定的能力边界，与本次 display 公式截半区分。**

[TextRun](../../shared/types.ts#L8) 仅有 `text`、`script: sub|sup`、斜体和粗体，没有“依附哪个基字”、嵌套层级、上下标同列或数学片段身份。[inline-text.ts:19–39](../../renderer/src/reflow/inline-text.ts#L19) 按 x 排列字形并相对整行 baseline 赋一个平面 script 样式；[Reader.tsx:1034–1043](../../renderer/src/components/Reader.tsx#L1034) 将这些 run 顺序渲染成独立 `<sub>/<sup>`。[styles.css:120–122](../../renderer/src/styles.css#L120) 只上下平移，不提供共同基字上的堆叠关系。

真实 p3 `From r...` 段落已呈现这种结构：`r`、sub `comb`、sup `[t]`、sub `,i` 顺序排出；另一个下标中的 `n_comb−1` 被压成同一层 sub `,n` + sub `comb−1`。字符串和样式都可能“保住了”，二维数学关系仍然丢失。README 已提示复杂嵌套行内公式需对照原页，这不能作为已经支持完整行内数学的依据。

后续宜给数学片段建立带基字／上下标子节点的结构，普通正文继续用 `TextRun`。无可靠结构的数学片段保留完整来源显示，不把半个表达式混入普通正文。现有 `Block.text` 与笔记偏移语义应维持，通过明确的 source-span 映射支持新显示结构，而不是为方便渲染重新定义选择偏移。

## 为什么现有测试全绿

本次实际运行了以下五套，全部通过，日志在证据目录 `test-*.log`：

| 测试 | 结果 | 对此次故障的盲区 |
|---|---|---|
| `tests/math-crop-ownership.mjs` | 通过 | 只检查数字上限 `1023` 和括号被纳入；没有普通字体的多词下标，不检查所有 glyph 有唯一 owner，也不检查裁片完整包住公式本体。见 15–30 行。 |
| `tests/crop-regression.mjs` | 通过 | 检查缓存、并发、取消、失败重试和人工提供的无效矩形被拒绝；没有把检测器输出接到裁图函数。下游拒绝无效 crop 与上游持续产出无效 crop 可以同时“通过”。见 92–121 行。 |
| `tests/reflow-regression.mjs` | 42 项通过 | 公式相关例子主要是单基线 `x=y` 加编号与前后文顺序（179–187 行），未覆盖词汇化下标、cases 断片、相邻编号公式竞争。 |
| `tests/inline-reflow.mjs` | 通过 | 断言 sub/sup 标志及拼接文字相等；`V_DD` 与 `10^-3` 是不同基字，未检查同一基字的上下标堆叠、嵌套下标或实际 DOM 几何。见 29–47、57–82 行。 |
| `tests/formula-structure.mjs` | 默认 9 项通过 | 直接喂完整公式 glyph，绕过区域检测；可选实际文献路径有手工预期，但为另一篇论文配置，不包含当前 SWCS 失败页。见 18–39、41–75 行。 |

缺口不在测试数量，而在验收链条：原 PDF → 真实字形布局 → 区域归属 → 裁片与正文相互排除 → 实际显示，尚未用这两篇失败文献锁定。

## 推荐结构与推进顺序

1. **统一来源表示和所有权。** 为 page glyph／绘图对象保留稳定 source ID、原位置与字体；建立 page-level ownership，而非每栏一个临时 `Set`。主行、上下标、重音、伸缩括号组件先形成候选连接关系，英文标签只作为弱特征，不能单独构成正文硬边界。
2. **先解决公式组与相邻边界，再产生矩形。** 候选区域显式识别编号、主体、cases 分支、上下限；对相邻公式、caption、正文的竞争统一裁决。可有包含多个独立编号子式的 display group，但每个来源字形只由该层级中的一个叶节点拥有；不能两个平行公式块都完整声称拥有它。
3. **从已确定成员生成 crop。** 裁片覆盖完整成员和相关绘图；扩边只补视觉留白，不新增语义成员。真实正文不得因一个“prose”布尔值覆盖已确认的公式字形。边界矛盾必须回到区域判定或输出完整来源 fallback，禁止落库负矩形、禁止静默裁掉公式来迁就边界。
4. **完整来源先于 LaTeX。** 原稿显示首先可靠；结构识别／OCR只处理已闭合区域。输出候选时保留来源成员覆盖信息与不确定项。保留人工确认机制。
5. **行内表达式单独建结构。** 在不改变 canonical text／笔记偏移契约的前提下，补数学片段的 base+sub+sup、嵌套与源位置映射；不能继续把“有 sub/sup 样式”等同“保留数学结构”。

成熟布局模型或数学识别库可以作为候选生产者接入这一表示；最终仍要满足同一所有权、覆盖、排序与裁片契约。选型由并行库调研提供，本报告不重复其研究。

## 交付验收应锁定什么

- SWCS p3 `(8)`、`(13)`、`(14)` 原稿完整；分支条件、求和上下限、长标签下标全部保留。`(9)`、`(15)` 不被重复吸入前式。
- 所有公式 glyph 有且只有一个叶级 owner；目标标签不会成为独立 `p`，也不会从图像和文字中同时丢失。
- SWCS p4 所有 crop 满足有限值、正宽高、页内有效范围；实际图片路径无“无效裁剪区域”错误。验收必须检查解析器实际输出，不能只测下游拒绝错误输入。
- 真实原页上手工确认的 glyph／分支／编号清单作为 fixture 预期；不要用同一错误检测器的输出自生成“金标”。保留两篇文献的少数失败页，不需扩成昂贵全库跑批。
- `(8)` 的 native LaTeX 若给出，必须含两个完整分支及正确条件；缺失源内容时不能返回“无 warning 的完整候选”。
- 行内验收加同一基字双脚本、嵌套下标、紧邻正文及翻译／笔记偏移保留；查看实际渲染，不能仅比较拼接字符串。
- 当前五套既有回归继续通过，尤其保留邻接 `where` 正文、真实引用、FP8／INT8、图注内简单上下标与笔记锚点。

本次已经足以确定上述根因与结构选择。字体估计对所有伸缩符号的误差幅度、其他未编号公式类型的覆盖率，以及替换布局模型的泛化效果，仍应由未来实施中的相应验收决定，不能从这次两个失败页外推。
