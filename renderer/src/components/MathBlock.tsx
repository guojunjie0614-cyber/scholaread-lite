import { useMemo, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { Block } from '@shared/types';
import type { PDFDocumentProxy } from '@/lib/pdf';
import { cropPageRegion } from '@/lib/pdf';
import { api } from '@/lib/api';
import { useRegionImage } from './useRegionImage';
import DesktopMenu from './DesktopMenu';
import { IconMore } from './icons';
import { ImagePreview } from './ImagePreview';
import './reader-controls.css';

interface Props {
  doc: PDFDocumentProxy | null;
  block: Block & { crop: [number, number, number, number] };
  onUpdated: (block: Block) => void;
}

export function MathBlock({ doc, block, onUpdated }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.latex ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [imagePreview, setImagePreview] = useState(false);
  const latex = editing ? draft : block.latex;
  const preview = useMemo(() => {
    if (!latex?.trim()) return {};
    try {
      return { html: katex.renderToString(latex, { displayMode: true, throwOnError: true,
        trust: false, output: 'htmlAndMathml', maxSize: 20, maxExpand: 1000, strict: 'warn' }) };
    } catch (e) { return { error: e instanceof Error ? e.message : '公式语法无效' }; }
  }, [latex]);
  const structured = !editing && block.latexVerified && preview.html;
  const { ref, src, error } = useRegionImage(doc, block.page, block.crop, true, !structured);
  const original = src ? (
    <img src={src} alt={`第 ${block.page} 页原稿公式${block.eqNo ?? ''}`}
      style={{ width: `${(block.crop[2] - block.crop[0]) / (block.sourceFontSize || 10)}em`, cursor: 'zoom-in' }} draggable={false}
      role="button" tabIndex={0} aria-label="预览原稿公式" title="双击放大查看"
      onDoubleClick={event => { event.stopPropagation(); setImagePreview(true); }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setImagePreview(true); } }} />
  ) : <span className="eq-fallback">{error ? `公式加载失败：${error}，请查看原页。` : '正在加载公式…'}</span>;

  const recognize = async () => {
    if (!doc) return;
    setBusy(true); setMessage('');
    try {
      const result = block.nativeLatex && !block.structureWarnings?.length
        ? { latex: block.nativeLatex, engine: 'pdf-structure' as const }
        : await api.formula.recognize(await cropPageRegion(doc, block.page, block.recognitionCrop ?? block.crop, 2));
      const updated = await api.blocks.setFormula(block.paperId, block.id, result.latex, false, block, result.engine);
      onUpdated(updated); setDraft(result.latex); setEditing(true);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const useOriginal = async () => {
    setBusy(true); setMessage('');
    try {
      onUpdated(await api.blocks.setFormula(block.paperId, block.id, block.latex || '', false, block, block.latexSource));
      setEditing(false);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const adopt = async () => {
    if (!preview.html) return;
    setBusy(true); setMessage('');
    try {
      onUpdated(await api.blocks.setFormula(block.paperId, block.id, draft, true, block, draft === block.latex ? block.latexSource : 'manual'));
      setEditing(false);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="equation-block" ref={ref} data-reviewing={editing || undefined}>
      <DesktopMenu ariaLabel={`公式${block.eqNo || ''}操作`} className="equation-menu" align="end" width={190} disabled={busy} items={[
        ...(block.latexVerified ? [{ id: 'original', label: '使用原稿', onSelect: () => void useOriginal() }] : []),
        { id: 'recognize', label: '识别为 LaTeX', disabled: !doc, onSelect: () => void recognize() },
        { id: 'edit', label: editing ? '收起对照' : block.latex ? '对照 / 编辑' : '输入 LaTeX', onSelect: () => { setDraft(block.latex || ''); setEditing(!editing); setMessage(''); } },
      ]}><IconMore width={16} height={16} /></DesktopMenu>
      <div className="eq">
        <div className={`eq-body${structured ? ' typeset' : ''}`}>
          {structured ? <div dangerouslySetInnerHTML={{ __html: preview.html! }} /> : original}
        </div>
        {block.eqNo && (structured || !block.eqNoInCrop) && !/\\tag\s*\{/.test(latex || '')
          ? <span className="eq-no">{block.eqNo}</span> : null}
      </div>
      {busy && <p className="eq-status" role="status">正在处理公式…</p>}
      {!editing && !busy && block.latex && !block.latexVerified && <button className="eq-pending" onClick={() => { setDraft(block.latex || ''); setEditing(true); }}>LaTeX 待确认 · 打开对照</button>}
      {!!block.formulaReviews?.length && <details className="eq-saved-reviews">
        <summary>已保存的单式校对（{block.formulaReviews.length}）</summary>
        <p>原稿将这些编号连成一个公式组；此前校对内容保留在这里。</p>
        {block.formulaReviews.map((review, index) => <label key={index}>{review.eqNo} · {review.latexVerified ? '已确认' : '手动草稿'}
          <textarea readOnly aria-label={`已保存公式 ${review.eqNo}`} value={review.latex} /></label>)}
      </details>}
      {editing && <div className="eq-review">
        <div className="eq-source">{draft !== block.latex ? '手动编辑' : block.latexSource === 'pdf-structure' ? 'PDF 结构提取' : block.latexSource === 'pix2tex' ? '图片 OCR' : 'LaTeX'} · 待确认</div>
        <label>LaTeX<textarea aria-label="公式 LaTeX" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} /></label>
        <div className="eq-preview" aria-label="公式排版预览">
          {preview.html ? <div dangerouslySetInnerHTML={{ __html: preview.html }} /> : <span>{preview.error || '输入公式后显示排版预览'}</span>}
        </div>
        <div className="eq-review-actions"><span>对照上方原稿检查上下标、运算符和括号。</span>
          <button className="btn primary" disabled={busy || !preview.html} onClick={adopt}>确认并采用排版</button>
        </div>
      </div>}
      {message && <p className="eq-error" role="alert">{message}</p>}
      {imagePreview && doc && src && <ImagePreview doc={doc} page={block.page} crop={block.crop} src={src} title={`第 ${block.page} 页 · 原稿公式${block.eqNo || ''}`} onClose={() => setImagePreview(false)} />}
    </div>
  );
}
