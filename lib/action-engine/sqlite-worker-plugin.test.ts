import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import type { SqlJsStatic } from 'sql.js';
import { describe, expect, it } from 'vitest';
import { sqliteWorkerPlugin } from '../../scripts/sqlite-worker-plugin.mjs';

// The actual build plugin and installed browser distribution are exercised.
// This Node/VM suite is not a deployment or a substitute for Workerd smoke tests.
const distributionUrl = new URL(
  '../../node_modules/sql.js/dist/sql-wasm-browser.js',
  import.meta.url,
);
const distributionId = fileURLToPath(distributionUrl);
const source = readFileSync(distributionUrl, 'utf8');
const token = 'ba=!!globalThis.WorkerGlobalScope';
const pinnedSha256 =
  '35e39a73b2e0bc1c2202a4cadb23bcf7a3a77071a39c270f014402968785b95f';

function transformed(id = distributionId) {
  const result = sqliteWorkerPlugin().transform(source, id);
  if (!result)
    throw new Error('The real SQLite distribution was not transformed.');
  return result;
}

function workerWithoutLocation(code: string) {
  let locationReads = 0,
    instantiations = 0;
  const self = Object.defineProperty({}, 'location', {
    get() {
      locationReads++;
      throw new Error('Worker Location is deliberately absent.');
    },
  });
  const sandbox = createContext({
    WorkerGlobalScope: class WorkerGlobalScope {},
    self,
    module: { exports: {} },
    exports: {},
    WebAssembly,
    TextDecoder,
    TextEncoder,
  });
  runInContext(code, sandbox, { timeout: 2000 });
  const initialize = sandbox.module.exports as (configuration: {
    instantiateWasm: (
      imports: WebAssembly.Imports,
      success: (instance: WebAssembly.Instance) => void,
    ) => WebAssembly.Exports;
    locateFile: () => never;
  }) => Promise<SqlJsStatic>;
  return {
    async initialize() {
      const wasm = readFileSync(
        new URL(
          '../../node_modules/sql.js/dist/sql-wasm-browser.wasm',
          import.meta.url,
        ),
      );
      const compiled = new WebAssembly.Module(wasm);
      return initialize({
        instantiateWasm(imports, success) {
          instantiations++;
          const instance = new WebAssembly.Instance(compiled, imports);
          success(instance);
          return instance.exports;
        },
        locateFile() {
          throw new Error('No runtime file/network lookup is allowed.');
        },
      });
    },
    locationReads: () => locationReads,
    instantiations: () => instantiations,
    sandbox,
  };
}

describe('real pinned SQLite Worker build plugin', () => {
  it('transforms exactly one detection token in the installed sql.js 1.14.2 bytes', () => {
    const metadata = JSON.parse(
      readFileSync(
        new URL('../../node_modules/sql.js/package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string };
    expect(metadata.version).toBe('1.14.2');
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      pinnedSha256,
    );
    const position = source.indexOf(token);
    expect(position).toBeGreaterThan(0);
    expect(source.indexOf(token, position + token.length)).toBe(-1);
    const result = transformed();
    expect(result.code).toBe(
      source.slice(0, position) +
        'ba=!1' +
        source.slice(position + token.length),
    );
    expect(result.map).toBeNull();
  });

  it('recognizes Vite query suffixes and normalized Windows dependency paths', () => {
    const expected = transformed();
    for (const id of [
      distributionId + '?commonjs-proxy',
      'C:\\build\\node_modules\\sql.js\\dist\\sql-wasm-browser.js',
      'D:\\workspace\\node_modules\\sql.js\\dist\\sql-wasm-browser.js?commonjs-entry&v=1',
    ])
      expect(transformed(id)).toEqual(expected);
  });

  it('does not rewrite application modules, other distributions or the WASM import', () => {
    const plugin = sqliteWorkerPlugin();
    for (const id of [
      '/app/worker.ts',
      '/app/sql-wasm-browser.js',
      '/node_modules/other/dist/sql-wasm-browser.js',
      '/node_modules/sql.js/dist/sql-wasm.js',
      '/node_modules/sql.js/dist/sql-wasm-browser.wasm?module',
      '/node_modules/sql.js/dist/sql-wasm-browser.js.map',
      '/node_modules/sql.js/dist/sql-wasm-browser.js/extra',
    ]) {
      expect(plugin.transform(source, id)).toBeNull();
      expect(plugin.transform('unrelated bytes', id)).toBeNull();
    }
  });

  it('refuses modified distributions, even harmless whitespace or a duplicated token', () => {
    const plugin = sqliteWorkerPlugin();
    for (const changed of [
      source + '\n',
      source.replace(token, 'ba=!!globalThis.window'),
      source + ';' + token + ';',
      'globalThis.unreviewedMutation=true;\n' + source,
    ])
      expect(() => plugin.transform(changed, distributionId)).toThrow(
        /Pinned SQLite Worker distribution changed/,
      );
  });

  it('refuses reprocessing already-transformed bytes instead of silently broadening the pin', () => {
    const result = transformed();
    expect(() =>
      sqliteWorkerPlugin().transform(result.code, distributionId),
    ).toThrow(/Pinned SQLite Worker distribution changed/);
  });

  it('does not add, remove or alter host worker/browser globals or any named global', () => {
    const snapshot = () =>
      new Map(
        Object.getOwnPropertyNames(globalThis).map((key) => [
          key,
          Object.getOwnPropertyDescriptor(globalThis, key)!,
        ]),
      );
    const before = snapshot();
    sqliteWorkerPlugin().transform(source, distributionId);
    const after = snapshot();
    const changes: string[] = [];
    // Compare descriptor identities before assertions inspect any host object;
    // recursively comparing globals can itself initialize Node's lazy services.
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(key),
        right = after.get(key);
      if (
        !left ||
        !right ||
        Reflect.ownKeys(left).length !== Reflect.ownKeys(right).length ||
        Reflect.ownKeys(left).some(
          (field) =>
            !Object.is(Reflect.get(left, field), Reflect.get(right, field)),
        )
      )
        changes.push(String(key));
    }
    expect(changes).toEqual([]);
  });

  it('the real transformed distribution initializes real compiled WASM without Worker Location or runtime lookup', async () => {
    const worker = workerWithoutLocation(transformed().code);
    const originalWorkerScope = worker.sandbox.WorkerGlobalScope;
    const originalSelf = worker.sandbox.self;
    const runtime = await worker.initialize();
    const db = new runtime.Database();
    try {
      expect(db.exec('SELECT 6 * 7 AS answer')).toEqual([
        { columns: ['answer'], values: [[42]] },
      ]);
      expect(worker.locationReads()).toBe(0);
      expect(worker.instantiations()).toBe(1);
      expect(worker.sandbox.WorkerGlobalScope).toBe(originalWorkerScope);
      expect(worker.sandbox.self).toBe(originalSelf);
    } finally {
      db.close();
    }
  });

  it('the unchanged pinned distribution fails in that same no-Location environment', async () => {
    const worker = workerWithoutLocation(source);
    await expect(worker.initialize()).rejects.toThrow(
      'Worker Location is deliberately absent.',
    );
    expect(worker.locationReads()).toBe(1);
    expect(worker.instantiations()).toBe(0);
  });
});
