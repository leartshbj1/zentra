import { expect, it } from 'vitest';
import { archivesWithoutCopy, copiesToRecover, vaultCopyFromRaw, type LegalArchive } from './legalArchive';

const archive = (year: number, sha256: string, present = true) => ({ id: `a${year}`, year, status: 'final', fileName: `archive-${year}.zip`, path: '', sha256, sizeBytes: 1, filesCount: 1, missingCount: 0, retainUntil: '', createdAt: '', lastVerifiedAt: null, lastVerifiedOk: null, present }) as LegalArchive;
const copy = (year: number, sha: string, completed = true) => vaultCopyFromRaw({ copy_id: `c${year}`, year, file_name: `archive-${year}.zip`, plain_sha256: sha, size_bytes: 10, key_id: 'k', created_at: 1, completed_at: completed ? 2 : null });

it('lists the archives still to copy and the copies to recover on this device', () => {
  const archives = [archive(2024, 'x'), archive(2025, 'y'), archive(2023, 'z', false)];
  const copies = [copy(2024, 'x'), copy(2025, 'y', false), copy(2022, 'w')];
  expect(archivesWithoutCopy(archives, copies).map((item) => item.year)).toEqual([2025]);
  expect(copiesToRecover(archives, copies).map((item) => item.year)).toEqual([2022]);
  expect(copy(2021, 'v', false).completedAt).toBeNull();
});
