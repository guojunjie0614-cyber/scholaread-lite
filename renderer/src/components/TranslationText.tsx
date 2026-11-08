import type { TranslationRun } from '@shared/translation-scripts';
import { InlineText } from './InlineText';

/** React escapes prose; only verified source script runs become markup. */
export function TranslationText({ runs }: { runs: TranslationRun[] }) {
  return <InlineText runs={runs} />;
}
