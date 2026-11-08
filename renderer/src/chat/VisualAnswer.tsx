import { lazy, Suspense } from 'react';
import { splitVisualAnswer } from '@shared/chat-visuals';
import { Markdown } from './Markdown';

const VisualBlock = lazy(() => import('./visuals/VisualBlock'));

export function VisualAnswer({ text, messageId, streaming, onFollowUp }: {
  text: string; messageId: string; streaming: boolean; onFollowUp(text: string): void;
}) {
  return <>{splitVisualAnswer(text).map(part => part.kind === 'markdown'
    ? <div data-chat-selectable={messageId} key={part.key}><Markdown text={part.text} /></div>
    : <Suspense key={part.key} fallback={null}><VisualBlock source={part.text}
      storageKey={`${messageId}:${part.key}`} streaming={streaming && !part.complete}
      incomplete={!part.complete && !streaming} onFollowUp={onFollowUp} /></Suspense>)}</>;
}
