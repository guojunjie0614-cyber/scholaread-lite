export type AgentId = 'codex' | 'claude' | 'agy';
export type ChatContextMode = 'paper' | 'general';

export interface AgentConfig { executablePath?: string; model?: string; effort?: string }
export interface AgentInfo {
  id: AgentId; label: string; available: boolean; executablePath: string | null;
  config: AgentConfig; images: boolean; detail?: string; unavailableReason?: string;
}
export interface ChatModel {
  id: string; providerId: AgentId; model: string; label: string;
  reasoningLevels: string[]; defaultReasoningEffort?: string; images?: boolean;
  /** AGY family effort levels resolve to these exact, runtime-listed model slugs. */
  reasoningVariants?: Record<string, string>;
  isDefault?: boolean; source?: 'runtime' | 'configured' | 'default';
}
export interface ChatCatalog { models: ChatModel[]; errors?: { providerId: AgentId; message: string }[] }
export interface PaperReference {
  id: string; paperId: string; title: string; page: number; blockIds: string[];
  quote: string; translated?: boolean; originalText?: string;
  crop?: [number, number, number, number];
}
export interface MessageReference { id: string; messageId: string; quote: string }
export interface ChatAttachment { id: string; name: string; mime: string; dataUrl: string }
export interface ChatConversation {
  id: string; paperId: string; title: string; providerId: AgentId; model: string;
  effort?: string;
  contextMode: ChatContextMode;
  createdAt: string; updatedAt: string;
}
export interface ChatMessage {
  id: string; conversationId: string; role: 'user' | 'assistant'; text: string;
  references: PaperReference[]; messageReferences: MessageReference[];
  attachments: ChatAttachment[]; status: 'complete' | 'streaming' | 'interrupted' | 'failed';
  error?: string; createdAt: string;
  providerId?: AgentId; model?: string; effort?: string;
  /** Original message IDs retained when history is copied into an edit branch. */
  originIds?: string[];
}
export interface ChatState { conversation: ChatConversation; messages: ChatMessage[]; running: boolean }
export interface ChatSendInput {
  conversationId: string; text: string; references?: PaperReference[];
  messageReferences?: MessageReference[]; attachments?: ChatAttachment[];
  scope?: 'selection' | 'paper';
  providerId?: AgentId; model?: string; effort?: string;
}
export interface ChatEvent { conversationId: string; state: ChatState; deleted?: boolean }
export interface ChatApi {
  providers(): Promise<AgentInfo[]>;
  catalog(refresh?: boolean): Promise<ChatCatalog>;
  configure(id: AgentId, config: AgentConfig): Promise<AgentInfo[]>;
  list(paperId: string): Promise<ChatConversation[]>;
  create(input: { paperId: string; providerId: AgentId; model?: string; effort?: string; contextMode?: ChatContextMode }): Promise<ChatState>;
  get(id: string): Promise<ChatState>;
  delete(conversationId: string): Promise<void>;
  restore(conversationId: string): Promise<ChatState>;
  rename(conversationId: string, title: string): Promise<ChatState>;
  fork(conversationId: string, beforeMessageId: string): Promise<ChatState>;
  send(input: ChatSendInput): Promise<void>;
  stop(conversationId: string): Promise<void>;
  onEvent(listener: (event: ChatEvent) => void): () => void;
}

/** Reader actions carry immutable source snapshots across focus changes. */
export interface ChatRequest {
  id: string; paperId: string; reference?: PaperReference; attachment?: ChatAttachment;
  text?: string; autoSend?: boolean;
}
