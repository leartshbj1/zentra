import {
  AccountPublicError,
  invoiceChainHash,
  isCanonicalDate,
  retentionUntil,
  sha256Hex,
} from './account-security';

export const MAX_ARCHIVED_PDF_BYTES = 12 * 1024 * 1024;
export const MAX_ARCHIVE_REQUEST_BYTES = 17 * 1024 * 1024;

export type InvoiceArchiveInput = {
  sourceInvoiceId: string;
  revision: number;
  invoiceNumber: string;
  issueDate: string;
  paidAt: string | null;
  correctionKind: 'initial' | 'correction';
  correctionReason: string | null;
  fiscalYearEnd: string | null;
  pdfBytes: Uint8Array;
};

function requiredText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized ||
    normalized.length > maximumLength ||
    normalized
      .split('')
      .some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
  ) {
    throw new AccountPublicError(`${label} est invalide.`);
  }
  return normalized;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isCanonicalDate(value.trim())) {
    throw new AccountPublicError(`${label} est invalide.`);
  }
  return value.trim();
}

export function decodePdfBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AccountPublicError('Le PDF de la facture est absent.');
  }
  if (value.length > Math.ceil((MAX_ARCHIVED_PDF_BYTES * 4) / 3) + 4) {
    throw new AccountPublicError(
      'Le PDF dépasse la limite de 12 Mo.',
      413,
    );
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new AccountPublicError('L’encodage du PDF est invalide.');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new AccountPublicError('L’encodage du PDF est invalide.');
  }
  if (binary.length === 0 || binary.length > MAX_ARCHIVED_PDF_BYTES) {
    throw new AccountPublicError(
      binary.length === 0
        ? 'Le PDF de la facture est vide.'
        : 'Le PDF dépasse la limite de 12 Mo.',
      binary.length > MAX_ARCHIVED_PDF_BYTES ? 413 : 400,
    );
  }
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
  const tail = new TextDecoder('ascii').decode(bytes.slice(-2_048));
  if (header !== '%PDF-' || !tail.includes('%%EOF')) {
    throw new AccountPublicError(
      'Le document transmis n’est pas un PDF complet.',
    );
  }
  return bytes;
}

export function normalizeArchiveInput(
  body: Record<string, unknown>,
): InvoiceArchiveInput {
  const sourceInvoiceId = requiredText(
    body.sourceInvoiceId,
    'La référence interne de facture',
    160,
  );
  const invoiceNumber = requiredText(
    body.invoiceNumber,
    'Le numéro de facture',
    120,
  );
  const revision =
    typeof body.revision === 'number' ? body.revision : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 9_999) {
    throw new AccountPublicError('Le numéro de version est invalide.');
  }
  const issueDate = optionalDate(body.issueDate, 'La date de facture');
  if (!issueDate) {
    throw new AccountPublicError('La date de facture est invalide.');
  }
  const paidAt = optionalDate(body.paidAt, 'La date de paiement');
  const fiscalYearEnd = optionalDate(
    body.fiscalYearEnd,
    'La fin de l’exercice comptable',
  );
  const correctionKind = body.correctionKind;
  if (correctionKind !== 'initial' && correctionKind !== 'correction') {
    throw new AccountPublicError('Le type de version est invalide.');
  }
  if (
    (revision === 1 && correctionKind !== 'initial') ||
    (revision > 1 && correctionKind !== 'correction')
  ) {
    throw new AccountPublicError(
      revision === 1
        ? 'La première version doit être marquée comme originale.'
        : 'Une version ultérieure doit être marquée comme correction.',
    );
  }
  const rawReason =
    typeof body.correctionReason === 'string'
      ? body.correctionReason.trim()
      : '';
  if (revision > 1 && (rawReason.length < 5 || rawReason.length > 1_000)) {
    throw new AccountPublicError(
      'Expliquez la correction en 5 à 1 000 caractères.',
    );
  }
  if (revision === 1 && rawReason) {
    throw new AccountPublicError(
      'La version originale ne doit pas contenir de motif de correction.',
    );
  }
  return {
    sourceInvoiceId,
    revision,
    invoiceNumber,
    issueDate,
    paidAt,
    correctionKind,
    correctionReason: rawReason || null,
    fiscalYearEnd,
    pdfBytes: decodePdfBase64(body.pdfBase64),
  };
}

export async function buildArchiveIdentity(input: {
  organizationId: string;
  archive: InvoiceArchiveInput;
  previousChainSha256: string | null;
}) {
  const contentSha256 = await sha256Hex(input.archive.pdfBytes);
  const keepUntil = retentionUntil(
    input.archive.issueDate,
    input.archive.fiscalYearEnd,
  );
  const sourceHash = await sha256Hex(input.archive.sourceInvoiceId);
  const revisionLabel = String(input.archive.revision).padStart(4, '0');
  const objectKey = `organizations/${input.organizationId}/invoices/${sourceHash}/revision-${revisionLabel}-${contentSha256}.pdf`;
  const chainSha256 = await invoiceChainHash({
    organizationId: input.organizationId,
    sourceInvoiceId: input.archive.sourceInvoiceId,
    revision: input.archive.revision,
    invoiceNumber: input.archive.invoiceNumber,
    issueDate: input.archive.issueDate,
    paidAt: input.archive.paidAt,
    correctionKind: input.archive.correctionKind,
    correctionReason: input.archive.correctionReason,
    contentSha256,
    retentionUntil: keepUntil,
    previousChainSha256: input.previousChainSha256,
  });
  return { contentSha256, retentionUntil: keepUntil, objectKey, chainSha256 };
}

export function safeInvoiceFilename(invoiceNumber: string, revision: number) {
  const stem = invoiceNumber
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80) || 'facture';
  return `${stem}-v${revision}.pdf`;
}
