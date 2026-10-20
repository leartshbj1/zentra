// Relevés CAMT déposés dans un dossier (Téléchargements par défaut) :
// Autopilote les repère, l'import attend toujours le clic. Le doublon est
// écarté par l'empreinte du fichier, puis par les écritures elles-mêmes.

export type StatementFile = Readonly<{
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
  sha256: string;
  messageType: 'camt.053' | 'camt.054';
  imported: boolean;
}>;

const FOLDER_KEY = 'zentra.bank.statement-folder.v1';

export function statementFileFromRaw(value: unknown): StatementFile | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  const messageType = text('message_type');
  if (!text('path') || !/^[0-9a-f]{64}$/.test(text('sha256')) || (messageType !== 'camt.053' && messageType !== 'camt.054')) return null;
  return {
    path: text('path'),
    name: text('name'),
    size: typeof row.size === 'number' ? row.size : 0,
    modifiedAt: text('modified_at') || null,
    sha256: text('sha256'),
    messageType,
    imported: row.imported === true,
  };
}

/** Relevés pas encore importés, le plus récent d'abord, au plus trois. */
export function newStatementFiles(files: readonly StatementFile[], ignored: ReadonlySet<string>): StatementFile[] {
  return files
    .filter((file) => !file.imported && !ignored.has(file.sha256))
    .sort((left, right) => (right.modifiedAt ?? '').localeCompare(left.modifiedAt ?? '') || left.name.localeCompare(right.name))
    .slice(0, 3);
}

export function savedStatementFolder(organizationId: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(FOLDER_KEY) || '{}') as Record<string, string>;
    // Le choix fait hors compte (« local ») vaut aussi une fois l’entreprise connectée.
    const value = all[organizationId] || all.local;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

export function saveStatementFolder(organizationId: string, folder: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(FOLDER_KEY) || '{}') as Record<string, string>;
    all[organizationId] = folder;
    localStorage.setItem(FOLDER_KEY, JSON.stringify(all));
  } catch {
    // Préférence locale seulement : le dossier par défaut reste utilisé.
  }
}

/** Nom court du dossier pour la carte : « Téléchargements », « Relevés »… */
export function folderLabel(folder: string): string {
  const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || folder;
}
