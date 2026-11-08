/** One parser for figure/table labels, including dotted conference figure numbers. */
export interface CaptionLabel {
  kind: 'figure' | 'table';
  label: string;
  hasDelimiter: boolean;
  text: string;
}

const CAPTION_START = /^(fig(?:ure)?\.?|scheme|tab(?:le)?\.?|图|表)\s*(\d+(?:\.\d+)*[a-z]?|[IVXLC]+)([.:：]?)(?=\s|$)\s*/i;

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
