import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('../src-tauri/icons/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('brand-manifest.json', root), 'utf8'));
for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = readFileSync(new URL(name, root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Approved icon changed: ${name}`);
  if (name.startsWith('ios/') && name.endsWith('.png')) {
    assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20), `iOS icon must be square: ${name}`);
    assert.equal(bytes[25], 2, `iOS icon must be opaque RGB: ${name}`);
  }
}
for (const api of [26, 33]) {
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    const xml = readFileSync(new URL(`android/mipmap-anydpi-v${api}/${name}.xml`, root), 'utf8');
    for (const match of xml.matchAll(/@drawable\/([a-z_]+)/g)) readFileSync(new URL(`android/drawable/${match[1]}.xml`, root));
    if (api === 33) assert.match(xml, /monochrome/);
  }
}
console.log(`Approved Zentra branding verified: ${Object.keys(manifest.files).length} platform assets.`);
