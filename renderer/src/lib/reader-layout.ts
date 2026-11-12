export const CHAT_MIN_WIDTH = 340;
export const CHAT_MAX_WIDTH = 640;
export const READER_MIN_WIDTH = 560;

/** Keep a useful reading column without overwriting the user's sidebar preference. */
export function readerLayout(viewportWidth: number, preferredChatWidth: number, sidebarRequested: boolean, aiOpen: boolean) {
  const railWidth = viewportWidth <= 1150 ? 228 : 260;
  const preferred = Number.isFinite(preferredChatWidth) ? preferredChatWidth : 420;
  const maxChatWidth = Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, Math.floor(viewportWidth * .42), viewportWidth - READER_MIN_WIDTH));
  const chatWidth = Math.max(CHAT_MIN_WIDTH, Math.min(preferred, maxChatWidth));
  const sidebarVisible = sidebarRequested && (!aiOpen || viewportWidth - railWidth - chatWidth >= READER_MIN_WIDTH);
  return { chatWidth, maxChatWidth, sidebarVisible };
}
