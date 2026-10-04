import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// This closed integration suite uses the real Vinext framework shims. Its
// runtime boundary supplies only synthetic D1/R2/env values; no platform env
// or production binding can be consulted during the tests.
const config = mergeConfig(
  base,
  defineConfig({
    cacheDir: fileURLToPath(
      new URL('./node_modules/.vite-capture', import.meta.url),
    ),
    resolve: {
      alias: {
        'next/navigation': fileURLToPath(
          import.meta.resolve('vinext/shims/navigation'),
        ),
        'next/headers': fileURLToPath(
          import.meta.resolve('vinext/shims/headers'),
        ),
        'cloudflare:workers': fileURLToPath(
          new URL(
            './lib/supplier-inbox/fixtures/closed-cloudflare-env.ts',
            import.meta.url,
          ),
        ),
      },
    },
  }),
);

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['lib/supplier-inbox/capture-concurrency.test.ts'],
  },
});
