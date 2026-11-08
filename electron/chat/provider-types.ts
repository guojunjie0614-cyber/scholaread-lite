import type { AgentConfig, ChatContextMode, ChatMessage } from '../../shared/chat-types.js';

export interface AgentImage { path: string; mime: string; base64: string }
export interface AgentRunInput {
  executable: string; config: AgentConfig; cwd: string; sessionId?: string;
  contextMode?: ChatContextMode;
  prompt: string; images: AgentImage[]; history: ChatMessage[]; signal: AbortSignal;
  onText(text: string): void; onSession(id: string): void;
}
/** Resolves only when a turn reaches a terminal state or is interrupted. */
export type RunAgent = (input: AgentRunInput) => Promise<void>;
