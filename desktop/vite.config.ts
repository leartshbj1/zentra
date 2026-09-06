import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localOcrAssets } from './build/localOcrAssets';

export default defineConfig({
  define: { __ZENTRA_PLATFORM__: JSON.stringify(process.env.TAURI_ENV_PLATFORM || 'desktop') },
  plugins: [react(), localOcrAssets()],
  worker: { format: 'es' },
  optimizeDeps: { entries: ['index.html'] },
  base: './',
  server: { watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
