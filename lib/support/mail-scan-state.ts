import { database } from '@/lib/runtime';
import type { GestionLink } from '@/lib/supplier-inbox/service';
import { sha256Hex } from '@/lib/account-security';
import { digest } from './crypto';
import type { MailReference } from './infomaniak';
import { SupportError } from './types';

// This is structural progress, never an authorization or a quota admission.
const LOOKUP_SIZE = 40;
const MAX_RESUME_BYTES = 64_000;
const MAX_RESUME_REFS = 1_024;
// Exact receipt identity from supplier-inbox/service.ts; the SQLite integration
// witnesses seed receipts through that public function to keep this compatible.
const mailReceiptId = (org:string, connection:string, message:string) => sha256Hex(JSON.stringify([org,connection,message]));
type ScanIdentity = {
  connection_id: string; workspace_id: string; mailbox_id: string;
  folder_id: string; since_at: number; scan_offset: number;
};
export type MailScanResume = {
  version: 1; identity: string; link: string; offset: number; count: number;
  createdAt: number; latestUid: string; messages: MailReference[];
};
export type MailScanHint = { duplicate: boolean; captured: boolean };

export async function scanLinkIdentity(link: GestionLink | null) {
  return digest(JSON.stringify(link ? [link.workspace_id, link.organization_id,
    link.connected_by, link.enabled, link.created_at] : null));
}
export async function scanProviderIdentity(mailbox: ScanIdentity, filter: {transport:'api'|'imap';firstUid:number|null}) {
  return digest(JSON.stringify([mailbox.connection_id, mailbox.workspace_id,
    mailbox.mailbox_id, mailbox.folder_id, mailbox.since_at,filter.transport,filter.firstUid]));
}

export function decodeMailScanResume(raw: string | null | undefined): MailScanResume | null {
  if (!raw || raw.length > MAX_RESUME_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'count,createdAt,identity,latestUid,link,messages,offset,version' ||
      value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.identity) || !/^[a-f0-9]{64}$/.test(value.link) ||
      !Number.isSafeInteger(value.offset) || value.offset < 0 ||
      !Number.isSafeInteger(value.count) || value.count < 0 ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      value.createdAt > Math.floor(Date.now() / 1000) + 60 ||
      Math.floor(Date.now() / 1000) - value.createdAt > 3_600 ||
      typeof value.latestUid !== 'string' || !/^\d{1,20}$/.test(value.latestUid) ||
      !Array.isArray(value.messages) || value.messages.length > MAX_RESUME_REFS) return null;
    const seen = new Set<string>();
    for (const ref of value.messages) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
        Object.keys(ref).sort().join(',') !== 'date,uid' ||
        typeof ref.uid !== 'string' || !/^\d{1,20}$/.test(ref.uid) || seen.has(ref.uid) ||
        !(ref.date === null || (Number.isFinite(ref.date) && ref.date >= 0))) return null;
      seen.add(ref.uid);
    }
    return value;
  } catch { return null; }
}
export function encodeMailScanResume(resume: MailScanResume): string {
  const encoded = JSON.stringify(resume);
  if (!decodeMailScanResume(encoded))
    throw new SupportError('La page de réception ne peut pas être reprise. La synchronisation sera réessayée.', 502);
  return encoded;
}

/** One bounded structural chunk. Completion hints cannot grant any effect. */
export async function mailScanHints(
  workspace: string, connection: string, externals: readonly string[], link: GestionLink | null,
) {
  if (externals.length > LOOKUP_SIZE) throw new Error('mail_scan_chunk_size');
  const db = database(), hints = new Map<string, MailScanHint>();
  if (!externals.length) return hints;
  const receipts = link?.enabled ? await Promise.all(externals.map(id => mailReceiptId(link.organization_id, connection, id))) : [];
  const reads = await Promise.allSettled([
    db.prepare(`SELECT external_id FROM support_tickets WHERE workspace_id=? AND connection_id=? AND external_id IN (${externals.map(() => '?').join(',')})`)
      .bind(workspace, connection, ...externals).all<{ external_id: string }>(),
    receipts.length ? db.prepare(`SELECT id FROM supplier_mail_receipts WHERE workspace_id=? AND id IN (${receipts.map(() => '?').join(',')})`)
      .bind(workspace, ...receipts).all<{ id: string }>() : Promise.resolve({ results: [] }),
  ]);
  // Drain both independent reads, but preserve duplicate-lookup failure
  // precedence instead of letting the faster rejection change the result.
  if (reads[0].status === 'rejected') throw reads[0].reason;
  if (reads[1].status === 'rejected') throw reads[1].reason;
  const tickets = reads[0].value, completed = reads[1].value;
  const duplicates = new Set(tickets.results.map(row => row.external_id));
  const receiptIds = new Set(completed.results.map(row => row.id));
  externals.forEach((external, index) => hints.set(external, {
    duplicate: duplicates.has(external), captured: receipts.length > 0 && receiptIds.has(receipts[index]),
  }));
  return hints;
}
export const MAIL_SCAN_LOOKUP_SIZE = LOOKUP_SIZE;
export async function mailScanLink(workspace:string) {
  return database().prepare('SELECT * FROM support_gestion_links WHERE workspace_id=?')
    .bind(workspace).first<GestionLink>();
}
