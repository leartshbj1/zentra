import { createServer, loadConfigFromFile } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mobile frontend build only; the lifecycle test supplies synthetic IPC.
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.ZENTRA_QA_PORT || 5412);
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(root, 'vite.config.ts'));
const server = await createServer({
  ...loaded.config, root, configFile: false,
  cacheDir: join(tmpdir(), `zentra-salary-certificate-mobile-vitecache-${port}`),
  define: { ...loaded.config.define, __ZENTRA_PLATFORM__: JSON.stringify('ios') },
  plugins: [{
    name: 'certificate-use-production-share-bridge', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/tests/payroll-fixture.ts')) return;
      // The payroll harness normally replaces this method for salary tests.
      // Keep the production method for certificate delivery acceptance.
      const assignment = 'desktopApi.shareExistingExport = async (path) => {';
      if (!code.includes(assignment)) throw new Error('Payroll share fixture changed; review the certificate preview adapter.');
      return code.replace(assignment, 'const unusedPayrollShareMock = async (path) => {');
    },
  }, ...loaded.config.plugins],
  server: { ...loaded.config.server, host: '127.0.0.1', port, strictPort: true },
});
await server.listen(); server.printUrls();
