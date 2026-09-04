import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  define: { __ZENTRA_PLATFORM__: JSON.stringify('desktop') },
  build: { outDir: '../.qa/mobile-build', emptyOutDir: true, rolldownOptions: { input: 'tests/mobile-harness.html' } },
});
