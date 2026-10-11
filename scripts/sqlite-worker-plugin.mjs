import { createHash } from 'node:crypto';

// sql.js 1.14.2's browser distribution mistakes Workerd for a classic worker
// and reads self.location.href. Workerd has no Location. Only this dependency's
// detection is changed; no application/browser global or fallback is modified.
// Its WASM is still statically bundled and instantiated as a compiled Module.
export function sqliteWorkerPlugin() {
  return {
    name: 'zentra-sqlite-worker-compat',
    enforce: 'pre',
    transform(code, rawId) {
      const id = rawId.replaceAll('\\', '/').split('?')[0];
      if (!id.endsWith('/sql.js/dist/sql-wasm-browser.js')) return null;
      const token = 'ba=!!globalThis.WorkerGlobalScope';
      if (
        createHash('sha256').update(code).digest('hex') !==
          '35e39a73b2e0bc1c2202a4cadb23bcf7a3a77071a39c270f014402968785b95f' ||
        code.split(token).length !== 2
      ) {
        throw new Error(
          'Pinned SQLite Worker distribution changed; review its runtime contract.',
        );
      }
      return { code: code.replace(token, 'ba=!1'), map: null };
    },
  };
}
