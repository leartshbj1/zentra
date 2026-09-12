// Inspect the actual production graph, including every locally shipped deferred asset.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

async function inspect(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(await readFile(path.join(root, '.vite/manifest.json'), 'utf8'));
  const initial = new Set();
  function visit(key) {
    assert.ok(manifest[key], `Missing module: ${key}`);
    if (initial.has(key)) return;
    initial.add(key);
    for (const dependency of manifest[key].imports || []) visit(dependency);
  }
  visit('index.html');
  const workspace = Object.keys(manifest).find(key => manifest[key].src === 'src/WorkspaceApp.tsx');
  assert.ok(workspace, 'Missing workspace entry');
  visit(workspace);
  const assets = new Set();
  for (const entry of Object.values(manifest)) {
    for (const dependency of [...entry.imports || [], ...entry.dynamicImports || []]) assert.ok(manifest[dependency], `Missing dependency: ${dependency}`);
    for (const file of [entry.file, ...entry.css || [], ...entry.assets || []]) {
      const target = path.resolve(root, file);
      assert.ok(target.startsWith(root + path.sep), `Asset outside the native bundle: ${file}`);
      assert.ok((await stat(target)).isFile(), `Missing shipped asset: ${file}`);
      assets.add(file);
    }
  }
  const files = [...new Set([...initial].map(key => manifest[key].file))];
  const contents = await Promise.all(files.map(file => readFile(path.join(root, file))));
  return { initial, manifest, report: { initialJsBytes: contents.reduce((sum, content) => sum + content.length, 0),
    initialJsGzipBytes: contents.reduce((sum, content) => sum + gzipSync(content).length, 0), initialJsFiles: files.length, verifiedLocalAssets: assets.size } };
}
const after = await inspect(process.argv[2] || 'dist');
const deferred = ['DetailedPayslipForm', 'DocumentEditor', 'SalesOrdersScreen', 'PurchasesScreen', 'CatalogScreen', 'DocumentDesignStudio', 'ProjectPlanningPanel', 'SalaryCertificates', 'QuoteInvoiceFolder'];
for (const name of deferred) {
  const key = Object.keys(after.manifest).find(key => after.manifest[key].src === `src/${name}.tsx`);
  assert.ok(key, `Missing deferred screen: ${name}`);
  assert.equal(after.initial.has(key), false, `${name} is still required at startup`);
}
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(config.build.frontendDist, '../dist', 'Native build must include the complete frontend directory');
const before = process.argv[3] ? await inspect(process.argv[3]) : null;
console.log(JSON.stringify({ after: after.report, before: before?.report,
  reductionPercent: before ? Math.round((1 - after.report.initialJsBytes / before.report.initialJsBytes) * 10000) / 100 : null,
  deferred, scope: 'Built JavaScript graph and local assets; not a device startup timing or installation test.' }, null, 2));
