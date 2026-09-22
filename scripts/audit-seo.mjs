import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://localhost:3107';
const origin = 'https://zentraapp.ch';
const sitemapResponse = await fetch(`${base}/sitemap.xml`);
assert.equal(sitemapResponse.status, 200);
const sitemap = await sitemapResponse.text();
const paths = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => new URL(m[1]).pathname);
assert(paths.length >= 20);
assert(!paths.includes('/produits'));
assert(!paths.includes('/telecharger'));
const results = [];
// Sequential requests avoid overloading the local on-demand compiler.
for (const path of paths) {
  const response = await fetch(base + path, { headers: { 'User-Agent': 'OAI-SearchBot' } });
  const html = await response.text();
  assert.equal(response.status, 200, `${path}: HTTP`);
  assert(!/noindex/i.test(response.headers.get('x-robots-tag') || ''), `${path}: robots header`);
  assert(!/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html), `${path}: robots meta`);
  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1];
  assert.equal(canonical?.replace(/\/$/, ''), (origin + path).replace(/\/$/, ''), `${path}: canonical`);
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1];
  assert(title, `${path}: title`);
  assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1, `${path}: single h1`);
  const schemas = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].map(m => JSON.parse(m[1]));
  assert(schemas.some(s => s['@graph']?.some(n => n['@type'] === 'Organization')), `${path}: publisher`);
  if (path === '/') {
    const faq = schemas.find(s => s['@type'] === 'FAQPage');
    assert.equal(faq?.mainEntity.length, 6);
    assert(html.includes('id="questions"'));
  }
  if (['/gestion', '/support', '/automation'].includes(path)) assert(schemas.some(s => s['@type'] === 'SoftwareApplication'), `${path}: software`);
  results.push({ path, status: response.status, title, schemas: schemas.length });
}
for (const path of ['/connexion', '/mot-de-passe', '/support/demo', '/compte', '/support/espace']) {
  const response = await fetch(base + path, { redirect: 'manual' });
  assert.match(response.headers.get('x-robots-tag') || '', /noindex/, `${path}: private noindex`);
}
for (const [from, to] of [['/telecharger', '/download'], ['/produits', '/']]) {
  const response = await fetch(base + from, { redirect: 'manual' });
  assert.equal(response.status, 308, `${from}: permanent redirect`);
  assert.equal(new URL(response.headers.get('location'), base).pathname, to);
}
const missing = await fetch(base + '/seo-route-inexistante');
assert.equal(missing.status, 404);
const robots = await (await fetch(base + '/robots.txt')).text();
assert(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
assert(!robots.includes('Disallow: /\n'));
const llms = await fetch(base + '/llms.txt');
assert.equal(llms.status, 200);
assert.match(llms.headers.get('content-type'), /text\/plain/);
assert((await llms.text()).includes(origin + '/features'));
console.log(JSON.stringify({ base, checkedPages: results.length, status: 'passed', pages: results }, null, 2));
