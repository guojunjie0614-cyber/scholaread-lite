# 论文 PDF 重排：成熟路线、现实边界与首选方案

日期：2026-10-30。调查范围：公开官方文档、官方源码、作者论文与模型卡；本机只读核对为 Apple M4、16 GB 统一内存。本报告没有安装解析器、下载模型权重、运行转换或上传用户论文，因此工具能力与本机可运行路径已有来源支持，当前失败论文上的质量和耗时仍待实测。

## 结论：先替换结构推断，再谈公式 OCR

**首选验证 MinerU 4.1.2 的本地 Standard 路线，把它当结构解析后端，而不是直接把 Markdown 塞入阅读器。** 消费有序语义块、行内公式、页码/区域和图像资源；重排端以完整公式和算法区域为不可拆原子，识别不可靠时显示完整原文区域，而不是显示半张公式图片再把剩余字符拼成正文。Docling 是一个必要对照，重点比较结构可追踪性、正文/附属内容分层与公式边界，不需要一开始部署五种解析器。

选择依据是本任务的匹配度，而非排行榜：MinerU 当前已经把结构模型、公式、算法、图文分组与本地 Apple Silicon 执行串到一起，且已有真正的重排输出接口；Docling 的文档树和 provenance 更适合借鉴，但“打开 formula enrichment”不会自动发现普通段落内漏掉的数学区域。下面分别列出可核查能力和剩余风险。

**产品路线建议：原生 HTML/JATS/LaTeX 可用且版本匹配时优先；只有 PDF 时走成熟解析器；无法可靠重建的局部退回完整原文区域。** ar5iv 本身就是从 LaTeXML 转换所得 HTML5 的服务，说明源结构路线与 PDF 逆向恢复是两种不同问题。获取源版本时必须保留版本关系，不能悄悄用不同版本替换用户的 PDF。[ar5iv 官方仓库](https://github.com/dginev/ar5iv)

## 先分清四种“重排”

1. **PDF 文字/几何读取**：PDF.js `TextItem` 提供字符串、transform、width、height、fontName、hasEOL；它们不是段落、公式、算法与图注的语义树。`getStructTree()` 可以读取已存在的结构树，但页面没有结构树时返回 `null`。因此应利用真实 PDF tags，而不能假定所有论文都有 tags，也不能把 `getTextContent()` 当成熟论文重排引擎。[PDF.js 官方 API 源码](https://mozilla.github.io/pdf.js/api/draft/api.js.html)
2. **结构提取**：恢复区域类型、阅读顺序、数学/代码/图片与关系，输出可追踪的中间模型。这是 MinerU、Docling、Marker 的主要价值，也是 GROBID 擅长的论文逻辑结构任务。
3. **语义重排**：在新宽度与字号下排版正文，正确呈现数学与代码，绑定图片和图注，处理正文外内容。解析成功并不等于交互阅读器已经正确；缩放、选词、回原文、横向溢出和失败提示仍属于产品层。
4. **视觉重排**：移动/裁切原页面像素区域，优先保留原样。K2pdfopt 通过 bitmap 区域分析、裁切和重新组合改善多栏阅读；默认允许 text reflow 的输出页面是位图。这是完整保真回退的成熟参考，不是可编辑语义数学恢复。[K2pdfopt 官方说明](https://www.willus.com/k2pdfopt/)、[官方 FAQ](https://www.willus.com/k2pdfopt/help/faq.shtml)

## 候选取舍

| 候选 | 能交给重排端什么 | 本任务取舍 |
|---|---|---|
| **MinerU 4.x** | 统一 MiddleJson、语义块、inline spans、图片资源；HTML/EPUB/PDF 等 renderer | **首个验证对象**。数学与算法路径较贴合需求；必须锁版本、实际模型和 assets 契约 |
| **Docling** | DoclingDocument：body/furniture、层次、provenance、bbox、图片/图注与公式项 | **唯一优先对照**。很好的产品中间模型参考；不能把 block formula enrichment 等同于 PDF 行内数学恢复 |
| **Marker** | 分页树形 JSON、Equation/TextInlineMath、图表分组、页眉/页脚等 | 有借鉴价值；模型使用/分发限制使其不适合不经许可核对就作为产品默认依赖 |
| **GROBID** | 科研论文 TEI、元数据、章节、引用、图表与公式位置 | 用于引用/论文结构，**不作数学重排主干** |
| **Nougat** | 页面图像到科学文档 markup，含 LaTeX | 研究基线；语言、生成失败与非商业模型许可不适合作当前默认路线 |

### MinerU：当前已经不只是“PDF 转 Markdown”

截至调查，源码 `mineru/version.py` 为 `4.1.2`。4.x 的 `flash/basic/standard/advanced` 是质量/计算档位，不是旧版 `pipeline/vlm/hybrid` 后端名称。Basic 用小模型，Standard 用小模型加 VLM；Apple Silicon 自动选择 Torch/MPS 与 llama.cpp/Metal。官方建议 Apple Silicon 至少 16 GB 统一内存并直接安装于 macOS。因此本机处在可验证的资源范围内，但 16 GB 包括系统、Electron 与模型共同使用的内存，不能据此许诺交互延迟或高并发。[版本源码](https://github.com/opendatalab/MinerU/blob/master/mineru/version.py)、[档位与运行时](https://opendatalab.github.io/MinerU/usage/tiers/)

模型路线采用全局布局与局部识别解耦：先在降采样页面识别结构，再读原分辨率 crop。对本次“公式上半截进入图片、下半截流入正文”的故障，这比直接提高文字 OCR 精度更对症；但布局漏检仍会传递到局部识别，换模型不会消灭边界错误。[MinerU2.5 原论文](https://arxiv.org/abs/2509.22186)

当前源码已有 `equation_inline`、算法 `code_body/sub_type=algorithm`、image/table/code caption 等内容类别的适配；它们是消费者应保留的语义区别，而不是全部降成 plain text。[当前 schema 适配源码](https://github.com/opendatalab/MinerU/blob/master/mineru/backend/postprocess/legacy_schema_adapter.py)

**它还有真正的 renderer，但入口不能混用：** `mineru.render.render()` 支持 HTML、EPUB、PDF 等；PDF 要显式选 `PdfLayout.REFLOW`，默认 AUTO 在几何完整的 PDF 上会保留原布局。不能看见“导出 PDF”就以为已经重排。`mineru-kit parse`、Tasks API 与 Python renderer 暴露的格式集合不同。MiddleJson 是有序语义内容；独立 JSON 还可能不含图片字节，交付时必须连 assets 一起保留。建议阅读器消费结构模型而非二次解析 Markdown；原生 renderer 可先作低成本对照。[官方输出契约](https://opendatalab.github.io/MinerU/reference/output_files/)

**本地性也要落实到配置。** 模型下载来源、远程 VLM、远程整文档解析、LLM 后处理是不同连接；本地安装并不意味着任意配置都不联网。标准档可本地执行，模型备齐后可选 local source。后续试验应保持远程解析与远程模型端点关闭，不启用云端“提升质量”。[模型与连接配置](https://opendatalab.github.io/MinerU/usage/model_source/)

### Docling：结构契约值得采用，数学能力必须按具体管线判断

DoclingDocument 将主体放进 `body`，页眉页脚等放进 `furniture`；保留层次、bbox 和 provenance，图片/表格是独立对象，阅读顺序由树中 children 顺序表达。这个模型比“很多行文本加几个 crop”更接近阅读器需要的稳定契约。[DoclingDocument 官方说明](https://docling-project.github.io/docling/concepts/docling_document/)

默认 Heron layout 模型直接区分 Formula、Code、Caption、Page-header、Page-footer、Picture 等区域；图像导出接口能保留实际图片 crop。这为公式边界、图注绑定和附属内容分离提供现成起点。[Heron 官方模型卡](https://huggingface.co/docling-project/docling-layout-heron)、[官方图像导出示例](https://docling-project.github.io/docling/_generated/examples/export_figures/)

关键边界是：当前 `CodeFormulaVlmModel.is_processable()` 只处理 CodeItem 或已标记 FORMULA 的 TextItem；普通正文段落里漏掉的数学不会因为打开 enrichment 自动变成公式。公式 crop 需要周围 margin，过宽又会带入编号/正文并诱发重复，官方文档已有相应控制。因此“支持公式”不能代替对行内上下标、多行 display equation、编号与 crop 完整性的验收。[实际调用路径](https://github.com/docling-project/docling/blob/main/docling/pipeline/standard_pdf_pipeline.py)、[当前公式阶段源码](https://github.com/docling-project/docling/blob/main/docling/models/stages/code_formula/code_formula_vlm_model.py)、[enrichment 官方说明](https://docling-project.github.io/docling/usage/enrichments/)

这个限制针对标准 PDF 管线的 block enrichment，不代表 Docling 完整 VLM 管线一概不支持行内数学；2.145.0 发布说明已包含保留 native VLM inline math 至导出的修复。对照时必须记录具体管线，不能只写工具名。[Docling 2.145.0 发布说明](https://github.com/docling-project/docling/releases/tag/v2.145.0)

macOS 有布局 MPS 与 Vision OCR 路线，也有 Granite-Docling 的 MLX 运行选项；**模型和引擎支持是逐项的**：官方目录中 CodeFormulaV2 是 Transformers 路线，Granite-Docling-258M 才同时列出 MLX。不要拿“Docling 支持 MPS/MLX”推导每个公式模型都可用同一种后端。源码旧 `code_formula_model.py` 仍存在，当前标准 PDF 管线调用的是 `code_formula_vlm_model.py`；调查/接入要看实际调用方。[模型与引擎目录](https://docling-project.github.io/docling/usage/model_catalog/)、[模型 preset 源码](https://github.com/docling-project/docling/blob/main/docling/datamodel/stage_model_specs.py)

### Marker：值得读源码，不宜只凭“Apache-2.0”接入

本次核对 Marker `2.1.0`、commit `71dd5fd7e51ab24f8624b6ba2fcb6014b4e40ed4`。当前实现已经是 Surya VLM 本地 inference server 加轻量模型；Apple Silicon 走 llama.cpp，不能再沿用“全部模型只需设 TORCH_DEVICE=mps”的旧介绍。fast 模式针对 CPU/MPS、减少 VLM 使用；balanced 使用更完整的识别路径，inline math 在两种模式下的启用条件不同。`--disable_ocr` 会关闭公式识别等全部 VLM 调用，不是只关扫描 OCR。[当前 README](https://github.com/datalab-to/marker/blob/71dd5fd7e51ab24f8624b6ba2fcb6014b4e40ed4/README.md)、[版本定义](https://github.com/datalab-to/marker/blob/71dd5fd7e51ab24f8624b6ba2fcb6014b4e40ed4/pyproject.toml)

其 BlockTypes 明确有 Equation、TextInlineMath、FigureGroup、TableGroup、PageHeader、PageFooter 等；但 Code 不等于可靠保留了数学伪代码，也没有专门 biography 类。模式选项和类名证明表达能力，不能证明当前论文被正确识别。[schema 源码](https://github.com/datalab-to/marker/blob/71dd5fd7e51ab24f8624b6ba2fcb6014b4e40ed4/marker/schema/__init__.py)

### GROBID：论文结构强，不会替我们恢复数学排版

它面向科研文献的元数据、正文、引用和 TEI 结构；可输出已识别结构的 PDF 坐标。可是官方 fulltext 定义明确说短 inline formula 不单独标注，FAQ 说明 superscript/subscript 信息目前不序列化到 TEI。把 GROBID 换到主干不能解决上下标散落和分式恢复；图表单元格结构也要专门工具。没有 text layer 的扫描文档需先 OCR。[项目定位](https://grobid.readthedocs.io/en/latest/Introduction/)、[公式标注定义](https://grobid.readthedocs.io/en/latest/training/fulltext/#formulas)、[官方 FAQ](https://grobid.readthedocs.io/en/latest/Frequently-asked-questions/)、[坐标接口](https://grobid.readthedocs.io/en/latest/Coordinates-in-PDF/)

GROBID 的 segmentation 区分正文、页眉页脚、参考文献与附录，值得借鉴，但不等于有专用 biography/photo 过滤器。其 Docker 文档有历史段落冲突：前面说镜像只支持 amd64，后面补充 CRF-only 自 0.8.1 起有 arm64。因此 Apple Silicon 评估应具体区分 CRF 与 full/Deep Learning 镜像，不把 Linux CUDA 路径套到 Mac。[分段定义](https://grobid.readthedocs.io/en/latest/training/segmentation/)、[Docker 官方文档](https://github.com/grobidOrg/grobid/blob/master/doc/Grobid-docker.md)

### Nougat：科学 OCR 的重要基线，不是此次默认产品方案

Nougat 从整页图像生成科学文档 markup，理解 LaTeX 的方向是对的；但其论文把生成重复列为明确限制，非拉丁文字会触发严重问题。官方 README 也明确中文、俄文、日文不适用，并可能出现 `[MISSING_PAGE]`。设备源码有 MPS 分支，说明并非“Mac 不能跑”；这不等于本机已有成功、稳定的运行证据。对保留原图、定位关系与可恢复阅读的产品，整页生成文本还需额外对齐与资产管线。[原论文 §5.4–5.5](https://arxiv.org/html/2308.13418)、[官方 README](https://github.com/facebookresearch/nougat)、[设备选择源码](https://github.com/facebookresearch/nougat/blob/main/nougat/utils/device.py)

## 许可：代码、权重、量化包分别核对

以下是调查时原文中的条件摘要；它们直接决定能否打包、分发或设为产品默认。

| 系统 | 代码与模型许可现状 | 对 ScholarLite 的影响 |
|---|---|---|
| Docling | 代码 MIT；Heron 权重 Apache-2.0；**CodeFormulaV2 为 CDLA-Permissive-2.0**，旧 CodeFormula 为 MIT；Granite-Docling-258M 为 Apache-2.0 | 不能把旧模型的 MIT 自动套给 V2。锁定具体权重清单并保留各自 notices |
| MinerU 当前 4.x | 当前 LICENSE 是 Apache-2.0 加附加条款：合并 MAU 超 1 亿或月收入超 US$20M 时需另行商业许可；第三方在线服务须显著署名 | 不再是旧版代码 AGPL，但也不能写成“纯 Apache，无其他条件” |
| MinerU 当前模型 | `MinerU-4_models_torch` 模型卡标 Apache-2.0；Pro-2605 原始权重 Apache-2.0；旧 2509 权重仍标 AGPL-3.0 | 用包的实际模型 registry，不按工具名统一推定许可 |
| Marker 当前 | 代码 Apache-2.0；权重是 modified AI Pubs Open RAIL-M，有收入/融资 US$5M 门槛、竞争用途限制；文本还把 Share-a-Like 条款写到 Output | 产品默认集成前需要明确解决相应权利，不能仅凭 README 的“个人/小公司免费”一句决定 |
| GROBID | 项目 Apache-2.0 | 许可较直接；数学能力仍不满足主干要求 |
| Nougat | 代码 MIT，权重 CC-BY-NC | 非商业权重不适合作可自由商业分发的默认模型 |

许可原始来源：[Docling LICENSE](https://github.com/docling-project/docling/blob/main/LICENSE)、[Heron](https://huggingface.co/docling-project/docling-layout-heron)、[CodeFormulaV2](https://huggingface.co/docling-project/CodeFormulaV2)、[旧 CodeFormula](https://huggingface.co/docling-project/CodeFormula)、[Granite-Docling](https://huggingface.co/ibm-granite/granite-docling-258M)、[MinerU 当前 LICENSE](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)、[MinerU 4 小模型包](https://huggingface.co/opendatalab/MinerU-4_models_torch)、[Pro-2605](https://huggingface.co/opendatalab/MinerU2.5-Pro-2605-1.2B)、[旧 2509](https://huggingface.co/opendatalab/MinerU2.5-2509-1.2B)、[Marker MODEL_LICENSE](https://github.com/datalab-to/marker/blob/71dd5fd7e51ab24f8624b6ba2fcb6014b4e40ed4/MODEL_LICENSE)、[GROBID License](https://grobid.readthedocs.io/en/latest/License/)、[Nougat License 声明](https://github.com/facebookresearch/nougat#license)。

**MinerU 在 Mac 分发上还有一个具体缺口：** 当前 registry 为 llama.cpp 选择 `jinzhenj/MinerU2.5-Pro-2605-1.2B-GGUF` 的 Q8 主文件与 mmproj，而非 OpenDataLab 原始权重仓库。这个实际被选择的仓库页面没有 model card，未展示明确模型许可。上游 Apache-2.0 不能代替对量化产物来源、附带许可/NOTICE 和打包义务的核对；此项影响正式分发，不能因为本地研究验证可做就略去。[实际模型选择源码](https://github.com/opendatalab/MinerU/blob/master/mineru/model/registry.py)、[实际 GGUF 仓库](https://huggingface.co/jinzhenj/MinerU2.5-Pro-2605-1.2B-GGUF)

## 六类失败应如何验收，而不是如何继续堆阈值

下表是产品要求与设计判断，不是任何解析器已经在用户论文上通过的结果。

| 现有问题 | 重排契约/优先策略 | 必须看见的结果 |
|---|---|---|
| 大公式分成图片和零碎正文 | equation 区域先归属；其内部字符只能属于该 equation；保留完整 bbox/crop、编号与源页 | 分子、分母、大括号、上下限完整，公式只出现一次，无残余字符进入正文 |
| 行内上下标落单 | 段落使用 text/math runs，数学有独立表示；不能可靠恢复时保留包含数学的完整最小上下文区域 | 改字号与宽度后 `x_i`、`x^2`、希腊字母、符号前后顺序仍正确 |
| 算法/伪代码拆散 | algorithm 与普通 paragraph 分开；保留逐行、缩进、行号与数学 runs；复杂块可用完整区域 | 条件、循环层次、行号和数学语义都未丢失；不把多行拼成散文 |
| 图片与图注错位 | image/table 与 caption/footnote 形成一个 group；跨栏和邻近段落不是简单最近距离 | 图、编号、图注始终一起；图片不吃进标题、正文或公式 |
| 版权/页眉页脚泄漏 | 保留 furniture 语义，默认不进入正文；单页 copyright 不能只靠跨页重复规则发现 | 页眉/出版信息不进入段落；正文脚注仍保留；原 PDF 不变 |
| 作者信息未隐藏 | 阅读投影分别识别首页作者/机构/通信作者与尾部 biography/肖像；书库元数据不参与阅读隐藏 | 首页作者、机构、通信作者及尾部传记/照片不进入重排正文；保留书库作者元数据、原稿和笔记，不误隐藏技术正文人像或附录 |

作者信息不是一个简单的 furniture 类别：首页作者/机构/通信作者与尾部传记/照片需要分别识别。上述公开通用分类器/模型契约不能证明有可靠的专用 biography 检测，需要结合章节语义、文章尾部结构、人物简介文本与照片归属做阅读投影策略；不能把“参考文献之后全删掉”当完成，因为有的论文将重要附录、图表和证明放在后面。隐藏只作用于重排阅读，书库作者元数据、原稿与笔记保留，通过现有原页查看即可。

## 建议的最小验证路径

1. **先固定当前失败论文中的少量关键页**：完整多行公式页、含行内上下标的双栏正文页、算法页、图+图注页、含单页版权及作者/机构/通信作者的首页、作者简介/照片尾页。用原 PDF 逐项记录完整区域和阅读投影中应保留/隐藏的内容，避免只用“文本看起来很多”判断成功。
2. **一次只验证一个首选候选**：本地 MinerU Standard，保存结构模型与 assets，并看其现成 HTML/重排 renderer 的实际结果。不要默认提高到 Advanced，也不要默认把全文发给通用大模型。若公式归属或内存/延迟不合格，再用 Docling 对同一关键页做有针对性的对照。
3. **验收顺序是保真先于可编辑**：先做到完整区域、无重复、无残余、顺序正确，再要求全部转成 LaTeX。识别结果能被 KaTeX/MathJax 解析只证明语法可排版，不证明符号正确。
4. **在实际阅读宽度下检查**：窄屏与大字号至少各看一次；通过现有原页对照公式/算法；测试横向滚动/完整放大；检查作者信息隐藏仅作用于阅读投影，书库元数据、原稿与笔记不变。原子化之后仍要确认没有 CSS 裁切或宽度溢出造成新的“半截”。
5. **记录真实本机代价**：冷启动、首个可读页、整组页总耗时、峰值内存和失败类型；在这些未测前不承诺秒级完成。16 GB Mac 先用单文档、低并发；权重、后端与版本一起记录以保持结果可解释。

停止条件很明确：当前故障页上的公式/算法/图注完整，正文无误吞与重复，附属内容策略正确，且本机耗时/内存可接受，再考虑产品迁移。若首选候选在这些页仍失败，应定位是布局边界、识别、结构适配还是显示端的问题，再决定是否局部回退或换 Docling；不再用整篇 OCR 重跑替代诊断。

## 来源与证据说明

- 本文区分了官方公开能力、源码中的实际入口、模型卡许可、产品设计判断与未实测事项。没有采用厂商自报榜单横向排名，也没有把 NVIDIA GPU 吞吐换算成 M4 延迟。
- 当前主分支在变化：本次读取 MinerU 为 4.1.2、Docling `pyproject.toml` 为 2.145.0、Marker 为 2.1.0。正式验证应固定可获取的发布版本与模型 revision，不能拿旧版命令、旧版权说明和新版 schema 混用。[Docling 版本源文件](https://github.com/docling-project/docling/blob/main/pyproject.toml)
