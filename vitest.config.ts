import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // Match Vinext's production request-header shim without installing Next.js.
      'next/headers': 'vinext/shims/headers',
      // Explicit imports use this virtual module in the production SSR build.
      // Node tests execute that same adapter without the UI-rewriting plugin.
      'zentra:site-language': fileURLToPath(new URL('./lib/site-language-server.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
