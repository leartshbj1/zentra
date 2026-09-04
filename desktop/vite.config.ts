import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: { __ZENTRA_PLATFORM__: JSON.stringify(process.env.TAURI_ENV_PLATFORM || 'desktop') },
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
