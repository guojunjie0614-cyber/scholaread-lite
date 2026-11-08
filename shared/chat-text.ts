/** Keep this expression aligned with the syntax rendered by chat/Markdown.tsx. */
export function chatInlinePattern(): RegExp {
  return /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\)|\$[^$\n]+\$|\\\([^\n]*?\\\))/g;
}

function inlineText(value: string, depth = 0): string {
  if (depth > 3) return value;
  return value.replace(chatInlinePattern(), token => {
    if (token.startsWith('`')) return token.slice(1, -1);
    if (token.startsWith('**')) return inlineText(token.slice(2, -2), depth + 1);
    if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      return /^https?:\/\//i.test(link[2]) ? inlineText(link[1], depth + 1) : link[1];
    }
    // A rendered formula's visual selection is not generally reversible to LaTeX.
    // Preserve its source rather than deleting mathematical operators or inventing text.
    return token;
  });
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => inlineText(cell.trim())).join('\t');
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const blockStart = (line: string) => /^(?:\s*```|\s*\$\$|\s*\\\[|#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?)/.test(line);

/** Plain text for the Markdown subset the app renders; code and raw HTML stay literal. */
export function markdownVisibleText(value: string): string {
  const lines = value.replace(/\r\n/g, '\n').split('\n'), output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { output.push(''); index++; continue; }
    if (/^\s*```/.test(line)) {
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) output.push(lines[index++]);
      if (index < lines.length) index++;
      continue;
    }
    if (/^\s*(\$\$|\\\[)/.test(line)) {
      const delimiter = line.trim().startsWith('$$') ? '$$' : '\\]';
      let formula = line.trim().slice(2); index++;
      if (formula.endsWith(delimiter)) formula = formula.slice(0, -2);
      else {
        while (index < lines.length && !lines[index].includes(delimiter)) formula += `\n${lines[index++]}`;
        if (index < lines.length) { formula += `\n${lines[index].split(delimiter)[0]}`; index++; }
      }
      output.push(formula.trim()); continue;
    }
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    if (heading) { output.push(inlineText(heading[2])); index++; continue; }
    if (index + 1 < lines.length && line.includes('|') && tableRule.test(lines[index + 1])) {
      output.push(cells(line)); index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) output.push(cells(lines[index++]));
      continue;
    }
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      const pattern = /^\s*\d+\.\s/.test(line) ? /^\s*\d+\.\s+(.*)/ : /^\s*[-*+]\s+(.*)/;
      while (index < lines.length) {
        const match = pattern.exec(lines[index]); if (!match) break;
        output.push(inlineText(match[1])); index++;
      }
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      output.push(inlineText(quote.join('\n'))); continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !blockStart(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) break;
      paragraph.push(lines[index++]);
    }
    output.push(inlineText(paragraph.join('\n')));
  }
  return output.join('\n');
}

export function containsChatQuote(source: string, quote: string): boolean {
  if (!quote.trim()) return false;
  if (source.includes(quote)) return true;
  const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
  return normalize(markdownVisibleText(source)).includes(normalize(quote));
}
