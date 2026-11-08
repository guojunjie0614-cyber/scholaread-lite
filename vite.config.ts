import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': r('./renderer/src'), '@shared': r('./shared') },
  },
  server: {
    port: 5273,
    strictPort: true,
    fs: { allow: [r('.')] },
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 4096,
  },
  // pdfjs 的 worker 需要作为独立资源产出
  worker: { format: 'es' },
});
