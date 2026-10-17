import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Release scripts carry their own node:test suites (run with `node --test`).
// The first WorkspaceApp test of a file pays for the lazy screen imports. In a
// full parallel run that alone can pass the 5 s default, and the timed-out test
// then leaves its React root to break the next tests of the file.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'scripts/**/*.test.mjs'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
}));
