/** One parser for figure/table labels, including dotted conference figure numbers. */
export interface CaptionLabel {
  kind: 'figure' | 'table';
  label: string;
  hasDelimiter: boolean;
  text: string;
}

const CAPTION_START = /^(fig(?:ure)?\.?|scheme|tab(?:le)?\.?|图|表)\s*(\d+(?:\.\d+)*[a-z]?|[IVXLC]+)([.:：]?)(?=\s|$)\s*/i;

const PROSE_VERB_OR_CONNECTOR = /^(?:(?:\([a-z0-9]+\)\s*(?:(?:and|or|,)\s*\([a-z0-9]+\)\s*)*)?(?:shows?|illustrates?|depicts?|presents?|compares?|demonstrates?|is|are|was|were|provides?|gives?|summarizes?|describes?|can|has|have|reveals?|indicates?|plots?|displays?|lists?|contains?|consists?|corresponds?|confirms?|verifies?|validates?|highlights?|captures?|denotes?|represents?|implies?|suggests?|proves?|outlines?|details?|reports?|tabulates?)\b|(?:in|on|at|to|from|with|for|by|and|or|as|where|which|that)\b|(?:[a-z0-9().,\s、，和与及或]*?(?:展示|显示|说明|表明|给出|列出|描述|描绘|比较|对比|总结|汇总|呈现|反映|验证|证实|体现|代表|表示|包含|包括|为|是|可[以见知]|如.*所示|可以看到|可以看出)))/i;

const DANGLING_PROSE_END = /(?:\b(?:in|of|to|from|with|by|for|at|on|as|see|and|or|than|into|onto|between|through|under|over|after|before|during|within|without|shown|illustrated|highlighted|depicted|plotted|presented|given|listed|summarized|described|reported|compared)|[,;，；、]|(?:如|见|在|于|由|与|和|及|或|看|从|把|将|对|向))$/i;

export function parseCaption(text: string): CaptionLabel | null {
  const match = text.trim().match(CAPTION_START);
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  return {
    kind: /^(?:tab|表)/.test(prefix) ? 'table' : 'figure',
    label: match[2],
    hasDelimiter: !!match[3],
    text: text.trim().slice(match[0].length),
  };
}

/** True when text after "Fig. X" / "图 X" is a prose clause rather than a caption title. */
export function isProseCaptionReference(label: CaptionLabel | null | undefined): boolean {
  if (!label || !label.text) return false;
  return PROSE_VERB_OR_CONNECTOR.test(label.text.trim());
}

/**
 * PDFFigures 2.0 paragraph-continuity gate: a line that continues an unfinished
 * same-size prose sentence (e.g. "... as shown in\nFig. 3. The PN code...") is
 * an inline mention wrapped to line start, never a standalone figure/table caption.
 */
export function isWrappedProseMention(
  prev: { text: string; x0: number; x1: number; y: number; size: number } | undefined,
  line: { text: string; x0: number; x1: number; y: number; size: number },
): boolean {
  if (!prev) return false;
  const dy = line.y - prev.y;
  if (dy <= 0 || dy > Math.max(prev.size * 1.75, 18)) return false;
  if (Math.abs(line.size - prev.size) > 0.8) return false;
  const prevText = prev.text.trim();
  if (!prevText || parseCaption(prevText)) return false;
  if (DANGLING_PROSE_END.test(prevText)) return true;
  if (!/[.!?:;。！？：；]$/.test(prevText) &&
      prev.x1 - prev.x0 >= line.size * 12 &&
      Math.abs(line.x0 - prev.x0) <= line.size * 1.5) {
    return true;
  }
  return false;
}

