export type AnswerPart = { kind: 'markdown'; text: string; key: number } | { kind: 'openui'; text: string; key: number; complete: boolean };
export const MAX_VISUAL_SOURCE = 64000;

/** Fence-aware splitting keeps existing code blocks literal and streaming OpenUI source out of the prose. */
export function splitVisualAnswer(text: string): AnswerPart[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const parts: AnswerPart[] = [];
  let prose: string[] = [], proseStart = 0;
  const flush = () => { if (prose.join('\n').trim()) parts.push({ kind: 'markdown', text: prose.join('\n'), key: proseStart }); prose = []; };
  for (let i = 0; i < lines.length;) {
    const fence = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(lines[i]);
    if (!fence) { if (!prose.length) proseStart = i; prose.push(lines[i++]); continue; }
    const start = i, marker = fence[1], language = fence[2].trim().toLowerCase();
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
    const content: string[] = []; i++;
    while (i < lines.length && !closing.test(lines[i])) content.push(lines[i++]);
    const complete = i < lines.length;
    if (complete) i++;
    if (language === 'openui') {
      flush(); parts.push({ kind: 'openui', text: content.join('\n'), key: start, complete });
    } else {
      if (!prose.length) proseStart = start;
      prose.push(...lines.slice(start, i));
    }
  }
  flush(); return parts;
}
