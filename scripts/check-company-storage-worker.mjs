import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Use the same workerd shipped with the project's Wrangler, rather than Node's
// fetch implementation: redirect modes differ between these two runtimes.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const secret = `sb_secret_${'a'.repeat(32)}`;
const payload = Buffer.from([0, 81, 255, 17]);
const prefix = `/storage/v1/object/zentra-company-data/${'a'.repeat(64)}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const calls = [];
let stored;
const origin = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.apikey, secret);
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = Buffer.concat(parts);
    calls.push({ method: request.method, path: request.url });
    if (request.url === `${prefix}/1` || (request.method === 'DELETE' && body.toString().includes('/1"'))) {
      response.writeHead(302, { Location: 'https://untrusted.invalid/credentials' }).end();
    } else if (request.method === 'POST' && request.url === `${prefix}/0`) {
      assert.equal(request.headers['x-upsert'], 'false');
      assert.equal(request.headers['content-type'], 'application/octet-stream');
      assert.deepEqual(body, payload);
      stored = body;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    } else if (request.method === 'GET' && request.url === `${prefix}/0`) {
      assert.ok(stored);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(stored);
    } else if (request.method === 'DELETE' && request.url === '/storage/v1/object/zentra-company-data') {
      assert.deepEqual(JSON.parse(body), { prefixes: [prefix.split('zentra-company-data/')[1] + '/0'] });
      stored = undefined;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
    } else throw new Error('Unexpected request');
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain' }).end(error.message);
  }
});
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
const source = ts.transpileModule(await readFile(new URL('../lib/supabase-server.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const worker = new Miniflare({
  compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
  bindings: { STORAGE_ORIGIN: `http://127.0.0.1:${origin.address().port}` },
  modules: [
    { type: 'ESModule', path: 'storage-worker-test.mjs', contents: `
      import {createSupabaseServerClient} from './storage-client.mjs';
      export default {async fetch(request,env){
        const client=createSupabaseServerClient({url:env.STORAGE_ORIGIN,secretKey:${JSON.stringify(secret)}});
        const path='${prefix.split('zentra-company-data/')[1]}';
        await client.companyChunk('POST',path+'/0',new Uint8Array([0,81,255,17]));
        const bytes=await client.companyChunk('GET',path+'/0');
        await client.removeCompanyChunks([path+'/0']);
        const refused=[];
        for(const action of [()=>client.companyChunk('POST',path+'/1',new Uint8Array([1])),()=>client.companyChunk('GET',path+'/1'),()=>client.removeCompanyChunks([path+'/1'])]){
          try {await action(); refused.push(false);} catch(error){refused.push(error.status===302);}
        }
        return Response.json({bytes:[...bytes],refused});
      }};` },
    { type: 'ESModule', path: 'storage-client.mjs', contents: source },
  ],
});
try {
  const response = await worker.dispatchFetch('http://localhost/check');
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { bytes: [...payload], refused: [true, true, true] });
  assert.equal(calls.length, 6);
  assert.equal(stored, undefined);
  console.log('PASS: workerd upload, exact-byte download, cleanup, and three refused redirects. Loopback data only.');
} finally {
  await worker.dispose();
  origin.closeAllConnections();
  await new Promise(resolve => origin.close(resolve));
}
