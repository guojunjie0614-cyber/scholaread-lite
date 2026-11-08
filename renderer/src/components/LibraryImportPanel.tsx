import { useEffect, useRef, useState } from 'react';
import type { LibraryImportProgress, LibraryImportResult } from '@shared/types';
import { api } from '@/lib/api';
import { IconFolder, IconSearch } from './icons';

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export function LibraryImportPanel({ hidden, onBusyChange, onImported }: {
  hidden: boolean; onBusyChange: (busy: boolean) => void; onImported: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<LibraryImportProgress | null>(null);
  const [result, setResult] = useState<LibraryImportResult | null>(null);
  const [error, setError] = useState('');
  const running = useRef(false);
  useEffect(() => {
    const unsubscribe = api.libraryImport.onProgress(value => { if (running.current) setProgress(value); });
    return () => { unsubscribe(); if (running.current) void api.libraryImport.cancel(); };
  }, []);

  const start = async (manual = false) => {
    if (running.current) return;
    running.current = true; setBusy(true); onBusyChange(true); setError(''); setResult(null); setProgress(null); setStopping(false);
    try {
      let imported: LibraryImportResult;
      if (manual) {
        const folder = await api.libraryImport.choose();
        if (!folder) return;
        setProgress({ total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, current: '', phase: 'importing' });
        imported = await api.libraryImport.start('folder', folder);
      } else {
        setProgress({ total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, current: '', phase: 'discovering' });
        imported = await api.libraryImport.auto();
      }
      setResult(imported); setProgress(null);
      await onImported();
    } catch (reason) {
      setError(message(reason));
      // A later error must not hide papers successfully copied earlier in the run.
      await onImported().catch(() => {});
    } finally {
      running.current = false; setBusy(false); onBusyChange(false); setStopping(false); setProgress(null);
    }
  };
  const stop = async () => {
    setStopping(true);
    try { await api.libraryImport.cancel(); }
    catch (reason) { setError(message(reason)); setStopping(false); }
  };
  const notFound = result?.sources?.length === 0 && !result.cancelled;
  return <div hidden={hidden} className="library-import-panel">
    <div className="settings-section-heading"><h3>文献库导入</h3></div>
    <p className="library-import-intro">自动查找本机文献库，导入已下载的 PDF。</p>
    <div className="library-import-actions">
      <button className="btn primary" disabled={busy} onClick={() => void start()}><IconSearch width={15} />查找并导入</button>
      <button className="btn icon ghost" title="手动选择文献库或 PDF 文件夹" aria-label="手动选择文献库或 PDF 文件夹" disabled={busy} onClick={() => void start(true)}><IconFolder /></button>
    </div>
    {busy && progress && <div className="library-import-status" role="status">
      <div><span>{stopping ? '正在停止…' : progress.phase === 'discovering' ? '查找文献库…' : progress.sourceLabel || '导入文献'}</span>
        <span>{progress.total ? `${progress.processed} / ${progress.total}` : ''}</span>
        <button className="btn icon ghost" title="停止" aria-label="停止导入" disabled={stopping} onClick={() => void stop()}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>
        </button>
      </div>
      <progress aria-label={progress.phase === 'discovering' ? '查找进度' : '导入进度'} max={progress.total || undefined} value={progress.total ? progress.processed : undefined} />
      {!!progress.current && <p className="import-current" title={progress.current}>{progress.current}</p>}
    </div>}
    {result && <div className="library-import-result" role="status">
      {notFound ? <><p>未找到可导入的本地文献库。</p><button className="btn ghost" onClick={() => void start(true)}>选择 PDF 文件夹…</button></>
        : <p>{result.cancelled ? '已停止 · ' : ''}新增 {result.imported} · 跳过 {result.skipped}{result.failed > 0 ? ` · 失败 ${result.failed}` : ''}</p>}
      {!!result.sources?.length && <details><summary>来源（{result.sources.length}）</summary><ul className="library-import-locations">{result.sources.map(location =>
        <li key={location.path}><strong>{location.label}</strong><span title={location.path}>{location.path}</span></li>)}</ul></details>}
      {!!result.issues.length && <details><summary>查看详情（{result.issues.length}）</summary><ul>{result.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
    </div>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <p className="library-import-footnote">保留原库，跳过已导入文献。</p>
  </div>;
}
