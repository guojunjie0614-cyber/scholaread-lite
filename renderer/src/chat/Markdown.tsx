import { Fragment, memo, useMemo, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { api } from '@/lib/api';
import { chatInlinePattern } from '@shared/chat-text';

function MathText({ value, display = false }: { value: string; display?: boolean }) {
  const html = useMemo(() => {
    try { return katex.renderToString(value, { displayMode: display, throwOnError: true, trust: false,
      maxSize: 20, maxExpand: 1000, strict: 'ignore', output: 'htmlAndMathml' }); }
    catch { return null; }
  }, [value, display]);
  return html ? <span className={display ? 'chat-math display' : 'chat-math'} dangerouslySetInnerHTML={{ __html: html }} />
    : <code>{value}</code>;
}

function inline(value: string, depth = 0): ReactNode[] {
  if (depth > 3) return [value];
  const result: ReactNode[] = [];
  const pattern = chatInlinePattern();
  let offset = 0;
  for (const hit of value.matchAll(pattern)) {
    if (hit.index! > offset) result.push(value.slice(offset, hit.index));
    const token = hit[0]; let node: ReactNode = token;
    if (token.startsWith('`')) node = <code>{token.slice(1, -1)}</code>;
    else if (token.startsWith('**')) node = <strong>{inline(token.slice(2, -2), depth + 1)}</strong>;
    else if (token.startsWith('$')) node = <MathText value={token.slice(1, -1)} />;
    else if (token.startsWith('\\(')) node = <MathText value={token.slice(2, -2)} />;
    else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      if (/^https?:\/\//i.test(link[2])) node = <a href={link[2]} onClick={event => {
        event.preventDefault(); void api.app.openExternal(link[2]);
      }}>{inline(link[1], depth + 1)}</a>;
      else node = link[1];
    }
    result.push(<Fragment key={`${hit.index}:${token}`}>{node}</Fragment>);
    offset = hit.index! + token.length;
  }
  if (offset < value.length) result.push(value.slice(offset));
  return result;
}

const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
const blockStart = (line: string) => /^(?:\s*```|\s*\$\$|\s*\\\[|#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?)/.test(line);

/** Render only known syntax; untrusted HTML stays a text node. KaTeX is the sole HTML producer. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]; const key = i;
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3); const code: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      nodes.push(<pre key={key}><code data-language={language}>{code.join('\n')}</code></pre>); continue;
    }
    if (/^\s*(\$\$|\\\[)/.test(line)) {
      const delimiter = line.trim().startsWith('$$') ? '$$' : '\\]';
      let formula = line.trim().slice(2); i++;
      if (formula.endsWith(delimiter)) formula = formula.slice(0, -2);
      else {
        while (i < lines.length && !lines[i].includes(delimiter)) formula += `\n${lines[i++]}`;
        if (i < lines.length) { formula += `\n${lines[i].split(delimiter)[0]}`; i++; }
      }
      nodes.push(<div key={key} className="chat-formula"><MathText display value={formula.trim()} /></div>); continue;
    }
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    if (heading) { nodes.push(<h4 key={key} data-level={heading[1].length}>{inline(heading[2])}</h4>); i++; continue; }
    if (i + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headers = tableCells(line); const rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]));
      nodes.push(<div key={key} className="chat-table"><table><thead><tr>{headers.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{headers.map((_, cell) => <td key={cell}>{inline(row[cell] ?? '')}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line); const items: ReactNode[] = [];
      const expression = ordered ? /^\s*\d+\.\s+(.*)/ : /^\s*[-*+]\s+(.*)/;
      while (i < lines.length) {
        const match = expression.exec(lines[i]); if (!match) break;
        items.push(<li key={i}>{inline(match[1])}</li>); i++;
      }
      nodes.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      nodes.push(<blockquote key={key}>{inline(quote.join('\n'))}</blockquote>); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) {
      if (i + 1 < lines.length && lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) break;
      paragraph.push(lines[i++]);
    }
    nodes.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="chat-markdown">{nodes}</div>;
});
