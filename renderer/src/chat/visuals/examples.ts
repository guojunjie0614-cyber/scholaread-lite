/** Small complete programs used in generation guidance and UI acceptance. */
export const chartExample = `root = Col([Title("两组实测延迟", "md"), Chart("bar", [{"方法": "A", "延迟": 12}, {"方法": "B", "延迟": 8}], "方法", ["延迟"]), Caption("延迟单位：ms；示例数据，非论文测量值。")])`;
export const sliderExample = `$s = 50
root = Col([Title("稀疏度与理想操作数", "md"), Slider($s, 0, 90, 5, "稀疏度", "%"), Chart("bar", [{"方案": "稠密", "操作数": 100}, {"方案": "跳零", "操作数": 100 - $s}], "方案", ["操作数"]), Text("剩余操作数：" + @Format(100 - $s)), Caption("假设各操作开销相同且无控制开销；用于理解趋势。")])`;
export const diagramExample = `root = Col([Title("计算数据流", "md"), Svg([Rect(10, 20, 110, 48, "surface", "chart1", 1, 1, 8), SvgText("输入", 65, 49, 15, "ink", "middle"), Line(125, 44, 185, 44, "chart1", 2), Path("M178 38L185 44L178 50", null, "chart1", 2), Rect(190, 20, 110, 48, "surface", "chart2", 1, 1, 8), SvgText("乘加", 245, 49, 15, "ink", "middle")], "0 0 320 88")])`;
