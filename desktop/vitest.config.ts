import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Release scripts carry their own node:test suites (run with `node --test`).
export default mergeConfig(viteConfig, defineConfig({
  test: { exclude: [...configDefaults.exclude, 'scripts/**/*.test.mjs'] },
}));
