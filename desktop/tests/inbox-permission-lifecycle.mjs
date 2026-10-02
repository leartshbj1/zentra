/** Real hooks and SDK, synthetic IPC; never sends a real business request. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5421';
const out = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), 'zentra-inbox-permission-after-20261002');
await mkdir(out, { recursive: true });
const report = {
  baseRevision: process.env.ZENTRA_QA_SOURCE || 'unspecified',
  supplierSourceSha256: createHash('sha256').update(await readFile(new URL('../src/supplierInbox.ts', import.meta.url))).digest('hex'),
  transport: 'Synthetic SDK IPC only; real hooks and React',
  cases: [],
};
const cases = [
  {name:'supplier-get-prepare',type:'supplier',step:'get',scenario:'prepare',alter:'permission'},
  {name:'supplier-get-import',type:'supplier',step:'get',scenario:'import',alter:'permission'},
  {name:'appointment-get-import',type:'appointment',step:'get',scenario:'import',alter:'permission'},
  {name:'supplier-during-prepare',type:'supplier',step:'prepare',scenario:'both',alter:'permission'},
  {name:'supplier-between-imports',type:'supplier',step:'import',scenario:'import',alter:'permission'},
  {name:'appointment-between-imports',type:'appointment',step:'import',scenario:'import',alter:'permission'},
  {name:'supplier-editable-control',type:'supplier',step:'get',scenario:'both',alter:'none'},
  {name:'supplier-blocked-control',type:'supplier',step:'import',scenario:'import',alter:'blocked'},
  {name:'supplier-manual-get',type:'supplier',step:'get',scenario:'prepare',alter:'permission',manual:true},
  {name:'supplier-manual-prepare',type:'supplier',step:'prepare',scenario:'prepare',alter:'permission',manual:true},
  {name:'supplier-manual-import',type:'supplier',step:'import',scenario:'prepare',alter:'permission',manual:true},
  {name:'supplier-manual-editable',type:'supplier',step:'get',scenario:'prepare',alter:'none',manual:true},
];
for (const [engine,kind] of [['Edge',pw.chromium],['WebKit',pw.webkit]]) {
  const browser = await kind.launch(engine==='Edge' ? {channel:'msedge',headless:true} : {headless:true});
  try {
    for (const c of cases) {
      const page = await browser.newPage();
      const errors = [], external = [];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>{
        const url = new URL(route.request().url());
        if (url.origin !== origin) { external.push(url.origin + url.pathname); return route.abort(); }
        return route.continue();
      });
      try {
        await page.goto(`${origin}/tests/inbox-permission-fixture.html?type=${c.type}&step=${c.step}&scenario=${c.scenario}${c.manual ? '&manual=1' : ''}`);
        await page.locator('[data-ready]').waitFor();
        if (c.manual) {
          await page.waitForFunction(() => document.querySelector('[data-ready]')?.getAttribute('data-items') === '2');
          await page.evaluate(() => { window.__qaInbox.manualDone = false; void window.__qaInbox.prepare().finally(() => { window.__qaInbox.manualDone = true; }); });
        }
        await page.waitForFunction(()=>window.__qaInbox.proof.pending);
        const before = await page.evaluate(()=>window.__qaInbox.proof.calls.length);
        if (c.alter === 'permission') {
          await page.evaluate(()=>window.__qaInbox.makeReadOnly());
          await page.waitForFunction(()=>window.__qaInbox.proof.renderReadOnly===true);
        } else if (c.alter==='blocked') await page.evaluate(()=>window.__qaInbox.block());
        await page.evaluate(()=>window.__qaInbox.release());
        await page.waitForFunction(() => document.querySelector('[data-ready]')?.getAttribute('data-items') === '2');
        if (c.manual) await page.waitForFunction(() => window.__qaInbox.manualDone);
        else if (!(c.step === 'get' && c.alter === 'permission')) {
          await page.waitForFunction(() => window.__qaInbox.proof.workspaceReads === 1 && window.__qaInbox.proof.calls.at(-1)?.action === null);
        }
        const proof = await page.evaluate(()=>structuredClone(window.__qaInbox.proof));
        const newMutations = proof.calls.slice(before).filter(row=>row.action);
        const row = {engine,...c,...proof,errors,external,newMutationsAfterAlter:newMutations};
        report.cases.push(row);
        await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
        assert.equal(proof.pending,false,c.name);
        assert.deepEqual(errors,[],c.name);
        assert.deepEqual(external,[],c.name);
        if (c.alter!=='none') assert.deepEqual(newMutations,[],`${engine} ${c.name}: no new write after permission or editor changes`);
        if (!c.manual && c.step==='get' && c.alter==='permission') {
          assert.equal(proof.workspaceReads,0,c.name);
          assert.equal(proof.publications,0,c.name);
        } else {
          // The request already sent before the change is allowed to complete;
          // its successful supplier creation/import remains visible, without replay.
          const expectedReads = c.manual
            ? c.alter === 'permission' && c.step === 'get' ? 1
              : c.alter === 'permission' && c.step === 'prepare' ? 2 : 3
            : 1;
          assert.equal(proof.workspaceReads,expectedReads,c.name);
          assert.equal(proof.publications,1,c.name);
        }
        if (c.alter==='none') assert.deepEqual(newMutations.map(call=>call.action),['prepareSuppliers','import','import']);
        if (c.step==='import') assert.equal(proof.calls.filter(call=>call.action==='import').length,1,c.name);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify({cases:report.cases.length,sourceSha256:report.supplierSourceSha256,errors:0,external:0,output:join(out,'report.json')}));
