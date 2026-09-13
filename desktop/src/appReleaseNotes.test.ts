import { describe, expect, it } from 'vitest';
import { compareReleaseVersions, releaseHistory, releaseHistoryCopy, releaseNotesFor } from './appReleaseNotes';
describe('version notes', () => {
  it('compares versions numerically and excludes future releases from history', () => {
    expect(compareReleaseVersions('1.9.0', '1.60.0')).toBe(-1);
    expect(compareReleaseVersions('1.62.1', '1.62.0')).toBe(1);
    expect(compareReleaseVersions('invalid', '1.62.0')).toBeNull();
    expect(releaseNotesFor('1.62.0').current?.version).toBe('1.62.0');
    expect(releaseNotesFor('1.62.0').older.map(entry => entry.version)).toEqual(['1.61.0', '1.60.0']);
    expect(releaseNotesFor('').older).toEqual([]);
    expect(releaseNotesFor('1.59.0').current).toBeUndefined();
    expect(releaseNotesFor('1.59.0').older).toEqual([]);
  });
  it('keeps version entries unique, newest first, with all four languages', () => {
    expect(new Set(releaseHistory.map(entry => entry.version)).size).toBe(releaseHistory.length);
    const messages = [...Object.values(releaseHistoryCopy)];
    releaseHistory.forEach((entry, index) => {
      if (index) expect(compareReleaseVersions(entry.version, releaseHistory[index - 1].version)).toBe(-1);
      messages.push(entry.title, ...entry.changes);
    });
    for (const message of messages) for (const language of ['fr', 'de', 'it', 'en'] as const) expect(message[language].length).toBeGreaterThan(10);
  });
});
