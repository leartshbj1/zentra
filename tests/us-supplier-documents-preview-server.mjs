import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ configFile: false, root, resolve: { alias: { '@': root } }, server: { host: '127.0.0.1', port: 4179, strictPort: true }, logLevel: 'warn' });
await server.listen();
process.stdout.write('Local synthetic fixture: http://127.0.0.1:4179/tests/us-supplier-documents-preview.html?lang=fr&theme=light\n');
