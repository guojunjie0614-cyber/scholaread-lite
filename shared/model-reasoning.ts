import type { ProviderConfig } from './types.js';

export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = NonNullable<ProviderConfig['reasoningEffort']>;

/** Filter protocol values without inventing capabilities absent from a catalogue. */
export function modelReasoningLevels(levels: readonly string[] = []): ReasoningEffort[] {
  return [...new Set(levels.map(level => level.trim()).filter((level): level is ReasoningEffort =>
    level !== 'default' && REASONING_EFFORTS.some(value => value === level)))];
}
