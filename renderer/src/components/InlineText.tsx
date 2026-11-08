import type { CSSProperties, ReactNode } from 'react';
import type { TextRun } from '@shared/types';

/** DOM text order is canonical; only source math geometry changes its visual placement. */
export function InlineText({ runs, renderText = text => text }: {
  runs: TextRun[];
  renderText?: (text: string, offset: number) => ReactNode;
}) {
  let offset = 0;
  const result: ReactNode[] = [];
  const renderRun = (run: TextRun, index: number, style?: CSSProperties) => {
    let content = renderText(run.text, offset);
    offset += run.text.length;
    if (run.italic) content = <em>{content}</em>;
    if (run.bold) content = <strong>{content}</strong>;
    // PDF enclosing-circle glyphs are separate from the digit. A combining
    // Unicode glyph would attach to a preceding DOM character instead.
    if (run.text === '\u20dd' && run.mathPosition) return <span key={index} className="inline-circle"
      style={{ ...style, width: `${run.mathPosition.width / run.mathPosition.size}em` }}>
      <span className="inline-circle-ink">{content}</span></span>;
    return run.script === 'sub' ? <sub key={index} style={style}>{content}</sub>
      : run.script === 'sup' ? <sup key={index} style={style}>{content}</sup>
      : <span key={index} style={style}>{content}</span>;
  };
  for (let index = 0; index < runs.length;) {
    const group = runs[index].mathPosition?.group;
    if (!group) { result.push(renderRun(runs[index], index)); index++; continue; }
    const start = index;
    while (index < runs.length && runs[index].mathPosition?.group === group) index++;
    const atom = runs.slice(start, index);
    const left = Math.min(...atom.map(run => run.mathPosition!.x));
    const right = Math.max(...atom.map(run => run.mathPosition!.x + run.mathPosition!.width));
    result.push(<span key={`math-${start}`} className="inline-math" style={{ minWidth: `${right - left}em` }}>
      {atom.map((run, i) => {
        const position = run.mathPosition!;
        return renderRun(run, start + i, { fontSize: `${position.size}em`,
          paddingLeft: `${(position.x - left) / position.size}em`,
          transform: `translateY(${position.y / position.size}em)` });
      })}
    </span>);
  }
  return <>{result}</>;
}
