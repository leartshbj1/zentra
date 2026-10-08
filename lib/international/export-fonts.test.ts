import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getUsExportFonts } from './export-fonts';

describe('fixed licensed US export fonts', () => {
  it('matches the pinned original files and their provenance', async () => {
    const provenance = JSON.parse(readFileSync('public/fonts/us-exports/provenance.json', 'utf8'));
    const fonts = await getUsExportFonts();
    for (const [index, bytes] of [fonts.regular, fonts.bold].entries()) {
      const record = provenance.fonts[index];
      const original = readFileSync(`public/fonts/us-exports/${record.file}`);
      expect(Buffer.compare(original, bytes)).toBe(0);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
      expect(bytes.byteLength).toBe(record.size);
    }
    const license = readFileSync('public/fonts/us-exports/OFL.txt');
    expect(createHash('sha256').update(license).digest('hex')).toBe(provenance.licenseSha256);
    expect(license.toString()).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('returns independent buffers on every call', async () => {
    const first = await getUsExportFonts();
    const expected = Array.from(first.regular.slice(0, 8));
    first.regular.fill(0);
    first.bold.fill(0);
    const next = await getUsExportFonts();
    expect(Array.from(next.regular.slice(0, 8))).toEqual(expected);
    expect(next.bold.some(byte => byte !== 0)).toBe(true);
    expect(next.regular).not.toBe(first.regular);
  });
});
