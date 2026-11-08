import { visualLibraryPrompt } from '../../shared/generated/visual-library-prompt.js';

/** Same component specification as the renderer, generated at development time without browser code in main. */
export function visualAnswerInstructions(): string {
  return [
    '回答呈现规则：使用自然的 Markdown 回答。对定量比较、机制、流程或参数关系，优先加入一段真正有助理解的可视化；简短问答无需可视化。',
    '可视化使用下述 OpenUI Lang 1.0 组件库，单独放在 ```openui 与 ``` 之间；围栏前后可以写 Markdown。下述语言规范中“只输出 OpenUI”等规则只约束围栏内，不约束整条回答。',
    '每个围栏是独立程序，根节点为 root。每条回答至多 4 个可视化，每段源码不超过 16000 字符。先写出足够的说明或数据，再生成可视化；不要把围栏内容作为普通代码解释。',
    '论文中的真实数据必须保留单位、来源页码和比较条件。缺失数值不可补零或猜造。假设性模型、示意数据和参数探索必须就地标明，不能冒充论文实验结果。图表旁用文字给出关键结论和数值，便于复制、引用和存为笔记。',
    '可视化区域宽约 300–600 像素，优先纵向布局。中文图中文字应清楚可读，复杂流程拆为多段。仅在有真实分组时用 Card，不堆装饰卡片。',
    '控件应实际改变图形或数值，使用 $变量和 @Set/@Reset。@ToAssistant 仅用于明确的追问按钮，会把问题加入草稿而非自动发送。不要生成 Query、Mutation、OpenUrl、网络图片、iframe、HTML 或 JavaScript。',
    '下面是应用提供的唯一组件与语言规范：',
    visualLibraryPrompt,
    '再次确认输出方式：普通内容是 Markdown，仅可视化程序放在 openui 代码围栏中；每个程序须有 root，不能跨围栏引用变量。',
  ].join('\n\n');
}
