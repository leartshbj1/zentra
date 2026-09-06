import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

// OCR executes only the runtime shipped with the application, including offline.
export function localOcrAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const tesseractRoot = dirname(require.resolve('tesseract.js/package.json'));
  const coreRoot = dirname(createRequire(join(tesseractRoot, 'package.json')).resolve('tesseract.js-core/package.json'));
  const files = new Map<string, string>([
    ['worker.min.js', join(tesseractRoot, 'dist/worker.min.js')],
    ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].flatMap((variant) =>
      ['wasm.js', 'wasm'].map((extension): [string, string] => {
        const name = `tesseract-core-${variant}.${extension}`;
        return [name, join(coreRoot, name)];
      })),
  ]);
  return {
    name: 'local-payslip-ocr-assets',
    configureServer(server) {
      server.middlewares.use('/ocr', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '');
        const path = files.get(name);
        if (!path) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [name, path] of files) this.emitFile({ type: 'asset', fileName: `ocr/${name}`, source: readFileSync(path) });
    },
  };
}
