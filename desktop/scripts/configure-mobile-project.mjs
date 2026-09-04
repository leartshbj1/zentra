import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== 'android') throw new Error('Specify android.');
const path = fileURLToPath(new URL('../src-tauri/gen/android/app/src/main/AndroidManifest.xml', import.meta.url));
let source = await readFile(path, 'utf8');
// Do not let Android restore encrypted installation references without their device key.
source = source.replace(/android:allowBackup="[^"]*"/g, 'android:allowBackup="false"');
if (!source.includes('android:allowBackup=')) source = source.replace('<application', '<application android:allowBackup="false"');
await writeFile(path, source);
