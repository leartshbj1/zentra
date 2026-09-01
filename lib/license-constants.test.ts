import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LICENSE_PUBLIC_KEY_B64URL } from './license-constants';

describe('Elyko license key contract', () => {
  it('keeps the server verifier aligned with the Windows application', () => {
    const desktopKey = readFileSync(
      new URL(
        '../desktop/src-tauri/license-public-key.b64url',
        import.meta.url,
      ),
      'utf8',
    ).trim();
    expect(LICENSE_PUBLIC_KEY_B64URL).toBe(desktopKey);
  });
});
