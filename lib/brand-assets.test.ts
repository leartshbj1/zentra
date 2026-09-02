import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function listFiles(directory: URL, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!entry.isDirectory()) return [relativePath];

    return listFiles(new URL(`${entry.name}/`, directory), relativePath);
  });
}

describe('public Zentra assets', () => {
  it('does not publish legacy Elyko filenames', () => {
    const legacy = listFiles(new URL('../public/', import.meta.url)).filter((name) =>
      /elyko/i.test(name),
    );

    expect(legacy).toEqual([]);
  });
});
