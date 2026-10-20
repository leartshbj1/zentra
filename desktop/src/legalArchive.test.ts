import { describe, expect, it } from 'vitest';
import { archiveDue, archiveProblems, archivesToVerify, legalArchiveFromRaw } from './legalArchive';

const archive = (patch: Record<string, unknown>) => legalArchiveFromRaw({ id: 'a', year: 2025, status: 'final', file_name: 'x.zip', path: 'C:/x.zip', sha256: 'f'.repeat(64), size_bytes: 10,
  files_count: 4, missing_count: 0, retain_until: '2035-12-31', created_at: '2026-02-01T10:00:00Z', last_verified_at: '2026-10-01T10:00:00Z', last_verified_ok: 1, present: true, ...patch });

describe('legal archive', () => {
  it('reads the register', () => {
    expect(archive({})).toMatchObject({ year: 2025, status: 'final', lastVerifiedOk: true, present: true, retainUntil: '2035-12-31' });
    expect(archive({ last_verified_ok: null }).lastVerifiedOk).toBeNull();
    expect(archive({ status: 'other' }).status).toBe('provisional');
  });

  it('asks for last year once it has entries', () => {
    expect(archiveDue({ archives: [], yearsWithEntries: [2026, 2025] }, '2026-10-20')).toBe(2025);
    expect(archiveDue({ archives: [archive({})], yearsWithEntries: [2026, 2025] }, '2026-10-20')).toBeNull();
    expect(archiveDue({ archives: [], yearsWithEntries: [2026] }, '2026-10-20')).toBeNull();
  });

  it('finds missing or altered archives and those to verify', () => {
    const state = { archives: [archive({ id: 'ok' }), archive({ id: 'gone', present: false }), archive({ id: 'bad', last_verified_ok: 0 }), archive({ id: 'old', last_verified_at: '2026-08-01T10:00:00Z' })], yearsWithEntries: [] };
    expect(archiveProblems(state).map(row => row.id)).toEqual(['gone', 'bad']);
    expect(archivesToVerify(state, Date.parse('2026-10-20T10:00:00Z')).map(row => row.id)).toEqual(['old']);
  });
});
