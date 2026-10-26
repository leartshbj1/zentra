/** Archive légale (GeBüV) d'une année, enregistrée sur cet appareil. */
export type LegalArchive = {
  id: string;
  year: number;
  status: 'final' | 'provisional';
  fileName: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  filesCount: number;
  missingCount: number;
  retainUntil: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  lastVerifiedOk: boolean | null;
  present: boolean;
};
export type LegalArchiveState = { archives: LegalArchive[]; yearsWithEntries: number[] };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function legalArchiveFromRaw(row: RawRow): LegalArchive {
  return {
    id: text(row.id), year: number(row.year), status: row.status === 'final' ? 'final' : 'provisional', fileName: text(row.file_name), path: text(row.path),
    sha256: text(row.sha256), sizeBytes: number(row.size_bytes), filesCount: number(row.files_count), missingCount: number(row.missing_count),
    retainUntil: text(row.retain_until), createdAt: text(row.created_at), lastVerifiedAt: text(row.last_verified_at) || null,
    lastVerifiedOk: row.last_verified_ok === null || row.last_verified_ok === undefined ? null : row.last_verified_ok === 1 || row.last_verified_ok === true,
    present: row.present === true,
  };
}

/** L'année précédente a des écritures mais aucune archive : à archiver. */
export function archiveDue(state: LegalArchiveState, today: string): number | null {
  const previous = Number(today.slice(0, 4)) - 1;
  return state.yearsWithEntries.includes(previous) && !state.archives.some(archive => archive.year === previous) ? previous : null;
}

/** Archives dont le fichier manque ou dont la dernière vérification a échoué. */
export function archiveProblems(state: LegalArchiveState): LegalArchive[] {
  return state.archives.filter(archive => !archive.present || archive.lastVerifiedOk === false);
}

/** Une vérification par mois suffit : la dernière date de plus de 30 jours. */
export function archivesToVerify(state: LegalArchiveState, now: number): LegalArchive[] {
  return state.archives.filter(archive => archive.present && (!archive.lastVerifiedAt || now - Date.parse(archive.lastVerifiedAt) > 30 * 86_400_000));
}

/** Copie chiffrée d'une archive dans le coffre Zentra (second support). */
export type VaultCopy = {
  copyId: string;
  year: number;
  fileName: string;
  plainSha256: string;
  sizeBytes: number;
  keyId: string;
  createdAt: number;
  completedAt: number | null;
};

export function vaultCopyFromRaw(row: RawRow): VaultCopy {
  return {
    copyId: text(row.copy_id), year: number(row.year), fileName: text(row.file_name), plainSha256: text(row.plain_sha256),
    sizeBytes: number(row.size_bytes), keyId: text(row.key_id), createdAt: number(row.created_at),
    completedAt: typeof row.completed_at === 'number' ? row.completed_at : null,
  };
}

/** Archives présentes sur l'appareil sans copie complète dans le coffre. */
export function archivesWithoutCopy(archives: readonly LegalArchive[], copies: readonly VaultCopy[]): LegalArchive[] {
  const copied = new Set(copies.filter((copy) => copy.completedAt !== null).map((copy) => copy.plainSha256));
  return archives.filter((archive) => archive.present && !copied.has(archive.sha256));
}

/** Copies du coffre dont l'archive manque sur cet appareil : à récupérer. */
export function copiesToRecover(archives: readonly LegalArchive[], copies: readonly VaultCopy[]): VaultCopy[] {
  const present = new Set(archives.filter((archive) => archive.present).map((archive) => archive.sha256));
  return copies.filter((copy) => copy.completedAt !== null && !present.has(copy.plainSha256));
}
