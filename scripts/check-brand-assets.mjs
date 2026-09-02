import { readdirSync } from 'node:fs';

function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!entry.isDirectory()) return [relativePath];

    return listFiles(new URL(`${entry.name}/`, directory), relativePath);
  });
}

const publicDirectory = new URL('../public/', import.meta.url);
const legacy = listFiles(publicDirectory).filter((name) => /elyko/i.test(name));

if (legacy.length) {
  throw new Error(
    `Publication Zentra refusée: ressources Elyko encore publiques: ${legacy.join(', ')}`,
  );
}
