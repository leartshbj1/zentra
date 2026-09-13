import { readFileSync, writeFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'));
const config = read('tauri.macos.updater-preview.conf.json');
const template = read('tauri.updater.conf.json');
const pubkey = readFileSync(new URL('../src-tauri/updater-public-key.txt', import.meta.url), 'utf8').trim();
if (!Buffer.from(pubkey, 'base64').toString('utf8').startsWith('untrusted comment: minisign public key')) throw Error('Invalid updater public key');
config.bundle.createUpdaterArtifacts = false;
config.plugins = { updater: { ...template.plugins.updater, pubkey } };
writeFileSync(new URL('../src-tauri/tauri.cloud-macos.generated.conf.json', import.meta.url), JSON.stringify(config, null, 2));
