import { Component, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Renderer, type ActionEvent, type OpenUIError, type ParseResult } from '@openuidev/react-lang';
import { MAX_VISUAL_SOURCE } from '@shared/chat-visuals';
import { library } from './library';
import './visuals.css';

const prefix = 'scholarlite-visual:';
function readState(key: string): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(prefix + key) ?? '{}'); } catch { return {}; }
}
function saveState(key: string, state: Record<string, unknown>) {
  const serialized = JSON.stringify(state);
  if (serialized.length > 64000) return;
  try { localStorage.setItem(prefix + key, serialized); } catch { /* UI remains usable if storage is full. */ }
}
function Failure({ source, message }: { source: string; message: string }) {
  return <details className="chat-visual-failure"><summary>{message}</summary><pre><code>{source}</code></pre></details>;
}
class VisualBoundary extends Component<{ children: ReactNode; source: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Failure source={this.props.source} message="可视化未能显示，查看内容" /> : this.props.children; }
}
function Program({ source, storageKey, streaming, onFollowUp }: {
  source: string; storageKey: string; streaming: boolean; onFollowUp(text: string): void;
}) {
  const initialState = useMemo(() => readState(storageKey), [storageKey]);
  const [errors, setErrors] = useState<string[]>([]);
  const [invalidProgram, setInvalidProgram] = useState(false);
  const [actionError, setActionError] = useState('');
  const onError = useCallback((values: OpenUIError[]) => {
    const next = values.filter(item => item.severity !== 'warning').map(item => item.code + ': ' + item.message);
    setErrors(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  const onStateUpdate = useCallback((state: Record<string, unknown>) => saveState(storageKey, state), [storageKey]);
  const onParseResult = useCallback((result: ParseResult | null) => {
    setInvalidProgram(!!result && ((!result.root && !result.rootExpression) || result.meta.incomplete
      || result.queryStatements.length > 0 || result.mutationStatements.length > 0));
  }, []);
  const onAction = useCallback((event: ActionEvent) => {
    // Local @Set/@Reset are handled by OpenUI. External actions never execute inside Electron.
    if (event.type !== 'continue_conversation') { setActionError('此操作不受支持'); return; }
    setActionError('');
    const message = event.humanFriendlyMessage?.trim();
    if (message) onFollowUp(message + (event.formState && Object.keys(event.formState).length ? `\n${JSON.stringify(event.formState)}` : ''));
  }, [onFollowUp]);
  return <>
    <div hidden={!streaming && (errors.length > 0 || invalidProgram)}><Renderer response={source} library={library} isStreaming={streaming}
      initialState={initialState} onStateUpdate={onStateUpdate} onAction={onAction} onError={onError}
      onParseResult={onParseResult}
      publishObservability={false} toolProvider={null} queryLoader={null} /></div>
    {!streaming && (errors.length > 0 || invalidProgram) && <Failure source={source} message="可视化未能显示，查看内容" />}
    {actionError && <p className="chat-visual-error" role="status">{actionError}</p>}
  </>;
}
export default function VisualBlock({ source, storageKey, streaming, incomplete, onFollowUp }: {
  source: string; storageKey: string; streaming: boolean; incomplete: boolean; onFollowUp(text: string): void;
}) {
  if (!source.trim() && streaming) return null;
  if (source.length > MAX_VISUAL_SOURCE) return <Failure source={source} message="可视化内容过长，查看内容" />;
  if (incomplete) return <Failure source={source} message="可视化未生成完整，查看内容" />;
  return <div className="chat-visual"><VisualBoundary source={source}><Program source={source} storageKey={storageKey} streaming={streaming} onFollowUp={onFollowUp} /></VisualBoundary></div>;
}
