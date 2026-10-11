/** Node-only Vitest alias. Actual WASM bytes; no replacement SQL implementation. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const compiledSqlite = new WebAssembly.Module(
  readFileSync(
    createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm-browser.wasm'),
  ),
);
export default compiledSqlite;
