import type { LiteApi } from '@shared/types';

declare global {
  interface Window {
    lite: LiteApi;
  }
}

export const api: LiteApi = window.lite;

export function assertBridge() {
  if (!window.lite) {
    throw new Error(
      '桌面桥未就绪：请通过 `npm run dev` 或打包后的应用启动，不要直接用浏览器打开 dist/index.html。',
    );
  }
}
