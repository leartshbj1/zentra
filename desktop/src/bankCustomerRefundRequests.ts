import { desktopApi } from './bridge';
import { recordDiagnostic } from './diagnostics';

type RequestCleanupTrace = { id?: string; started?: number };
function recordRequestCleanup(phase: 'start' | 'success' | 'failure', trace: RequestCleanupTrace = {}): RequestCleanupTrace {
  try {
    if (phase === 'start') trace.started = performance.now();
    trace.id = recordDiagnostic({
      id: trace.id, area: 'draft', operation: 'bank.customer_request_cleanup', phase,
      ...(phase === 'start' || trace.started === undefined ? {} : { durationMs: performance.now() - trace.started }),
      ...(phase === 'failure' ? { errorCode: 'STORAGE' } : {}),
    });
  } catch { /* A journal failure must not replace the committed financial result. */ }
  return trace;
}

type RequestContext = { requestId: string; movementId: string; description: string; amountCents: number; currency: string; date: string };
export type BankCustomerRequest = RequestContext & (
  | { kind: 'create'; customerCreditNoteId: string; reference: string; reason: string; receipt: File | null }
  | { kind: 'match'; refundId: string; dateDifferenceReason?: string }
  | { kind: 'unlink'; matchId: string; reason: string }
);
export type BankCustomerRequestOrigin = { companyId: string; organizationId?: string; memberId: string };
export type ScopedBankCustomerRequest = { version: 2; origin: BankCustomerRequestOrigin; request: BankCustomerRequest };
type StoredReceipt = { name: string; type: string; lastModified: number; bytes: ArrayBuffer };
type StoredRequest = Exclude<BankCustomerRequest, { kind: 'create' }> | (Omit<Extract<BankCustomerRequest, { kind: 'create' }>, 'receipt'> & { receipt: StoredReceipt | File | null });
type StoredScopedRequest = { key: string[]; version: 2; origin: BankCustomerRequestOrigin; request: StoredRequest };
function restoredRequest(request: StoredRequest): BankCustomerRequest {
  if (request.kind !== 'create' || !request.receipt || request.receipt instanceof File) return request as BankCustomerRequest;
  const { bytes, name, type, lastModified } = request.receipt;
  return { ...request, receipt: new File([bytes], name, { type, lastModified }) };
}
function requireOrigin(origin: BankCustomerRequestOrigin | null | undefined): BankCustomerRequestOrigin {
  if (!origin || typeof origin.companyId !== 'string' || !origin.companyId.trim() || typeof origin.memberId !== 'string' || !origin.memberId.trim() || (origin.organizationId !== undefined && typeof origin.organizationId !== 'string')) {
    throw new Error('L’identité de cet espace doit être vérifiée avant de reprendre une demande bancaire.');
  }
  return { companyId: origin.companyId, organizationId: origin.organizationId, memberId: origin.memberId };
}
export function sameBankCustomerOrigin(first: BankCustomerRequestOrigin | null | undefined, second: BankCustomerRequestOrigin | null | undefined): boolean {
  return Boolean(first && second && first.companyId === second.companyId && (first.organizationId ?? '') === (second.organizationId ?? '') && first.memberId === second.memberId);
}
function requestKey(origin: BankCustomerRequestOrigin, movementId: string): string[] { return [origin.companyId, origin.organizationId ?? '', origin.memberId, movementId]; }
function requireActive(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Cette action a été annulée avant son enregistrement.', 'AbortError'); }
export const BANK_CUSTOMER_REQUEST_EVENT = 'zentra:bank-customer-request';
let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Le stockage de reprise est indisponible sur cet appareil.')); return; }
    const request = indexedDB.open('zentra-bank-customer-requests', 2);
    let settled = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('requests')) request.result.createObjectStore('requests', { keyPath: 'movementId' });
      if (!request.result.objectStoreNames.contains('requests_v2')) request.result.createObjectStore('requests_v2', { keyPath: 'key' });
    };
    request.onerror = () => { settled = true; reject(new Error('Impossible d’ouvrir les demandes conservées sur cet appareil.')); };
    request.onblocked = () => { settled = true; reject(new Error('Fermez les autres fenêtres de Zentra puis réessayez.')); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
  }).catch(error => { database = null; throw error; });
  return database;
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction, result: (value: T) => void, fail: (message: string) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(new Error('Impossible de conserver la demande. Aucun nouvel enregistrement ne sera envoyé sans une copie de reprise.'));
    const fail = (message: string) => { reject(new Error(message)); tx.abort(); };
    try { action(tx, value => { result = value; }, fail); }
    catch { fail('La demande ne peut pas être conservée sur cet appareil. La vérification n’a pas démarré.'); }
  });
}
const notify = () => window.dispatchEvent(new Event(BANK_CUSTOMER_REQUEST_EVENT));
export async function listBankCustomerRequests(origin: BankCustomerRequestOrigin): Promise<ScopedBankCustomerRequest[]> {
  const verified = requireOrigin(origin);
  const rows = await transaction<StoredScopedRequest[]>(['requests_v2'], 'readonly', (tx, result) => { const request = tx.objectStore('requests_v2').getAll(); request.onsuccess = () => result(request.result); });
  return rows.filter(row => row.version === 2 && sameBankCustomerOrigin(row.origin, verified)).map(row => ({ version: 2, origin: row.origin, request: restoredRequest(row.request) }));
}
/** Old copies have no trustworthy owner. Reading them never migrates, removes or sends them. */
export async function listLegacyBankCustomerRequests(): Promise<BankCustomerRequest[]> {
  const rows = await transaction<StoredRequest[]>(['requests'], 'readonly', (tx, result) => { const request = tx.objectStore('requests').getAll(); request.onsuccess = () => result(request.result); });
  return rows.map(restoredRequest);
}
function signature(request: BankCustomerRequest): string {
  return JSON.stringify(request.kind === 'create' ? { ...request, receipt: request.receipt ? { name: request.receipt.name, size: request.receipt.size, type: request.receipt.type, lastModified: request.receipt.lastModified } : null } : request);
}
async function encodedRequest(request: BankCustomerRequest, signal?: AbortSignal): Promise<StoredRequest> {
  requireActive(signal);
  // Await the file before opening a transaction. Keep the existing WebKit-safe binary representation.
  const encoded: StoredRequest = request.kind === 'create' && request.receipt
    ? { ...request, receipt: { name: request.receipt.name, type: request.receipt.type, lastModified: request.receipt.lastModified, bytes: await request.receipt.arrayBuffer() } }
    : request;
  requireActive(signal);
  return encoded;
}
async function retainRequest(request: BankCustomerRequest, origin: BankCustomerRequestOrigin, signal?: AbortSignal): Promise<BankCustomerRequest> {
  const encoded = await encodedRequest(request, signal), key = requestKey(origin, request.movementId);
  const saved = await transaction<BankCustomerRequest>(['requests_v2'], 'readwrite', (tx, result, fail) => {
    requireActive(signal);
    const store = tx.objectStore('requests_v2'), existing = store.get(key);
    existing.onsuccess = () => {
      if (signal?.aborted) { fail('Cette action a été annulée avant son enregistrement.'); return; }
      const previous: StoredScopedRequest | undefined = existing.result;
      if (previous) {
        if (previous.version !== 2 || !sameBankCustomerOrigin(previous.origin, origin) || signature(restoredRequest(previous.request)) !== signature(request)) { fail('Une demande est déjà conservée pour ce mouvement. Vérifiez-la dans « Demandes à vérifier » avant de changer le choix.'); return; }
        result(restoredRequest(previous.request)); return;
      }
      try { store.put({ key, version: 2, origin, request: encoded } satisfies StoredScopedRequest); result(request); }
      catch { fail('Le justificatif et la demande ne peuvent pas être conservés sur cet appareil. La vérification n’a pas démarré.'); }
    };
  });
  notify(); return saved;
}
export async function removeBankCustomerRequest(request: BankCustomerRequest, origin: BankCustomerRequestOrigin): Promise<void> {
  const verified = requireOrigin(origin), key = requestKey(verified, request.movementId);
  await transaction<void>(['requests_v2'], 'readwrite', (tx, result, fail) => {
    const store = tx.objectStore('requests_v2'), existing = store.get(key);
    existing.onsuccess = () => {
      const row: StoredScopedRequest | undefined = existing.result;
      if (row && (row.version !== 2 || !sameBankCustomerOrigin(row.origin, verified) || row.request.requestId !== request.requestId)) { fail('La demande conservée a changé. Actualisez la liste.'); return; }
      try { store.delete(key); result(undefined); }
      catch { fail('La copie locale ne peut pas être retirée. Elle reste conservée.'); }
    };
  });
  notify();
}
/** Caller must first read this company's bank history and explicitly ask the user to choose this origin. No financial call is made here. */
export async function adoptLegacyBankCustomerRequest(request: BankCustomerRequest, origin: BankCustomerRequestOrigin, signal?: AbortSignal): Promise<void> {
  const verified = requireOrigin(origin), encoded = await encodedRequest(request, signal), key = requestKey(verified, request.movementId);
  await transaction<void>(['requests', 'requests_v2'], 'readwrite', (tx, result, fail) => {
    requireActive(signal);
    const legacy = tx.objectStore('requests'), scoped = tx.objectStore('requests_v2'), existing = legacy.get(request.movementId);
    existing.onsuccess = () => {
      if (signal?.aborted) { fail('Cette action a été annulée avant son enregistrement.'); return; }
      if (!existing.result || signature(restoredRequest(existing.result)) !== signature(request)) { fail('La demande ancienne a changé. Relisez-la avant de choisir son entreprise.'); return; }
      const current = scoped.get(key);
      current.onsuccess = () => {
        if (signal?.aborted) { fail('Cette action a été annulée avant son enregistrement.'); return; }
        const previous: StoredScopedRequest | undefined = current.result;
        if (previous && (previous.version !== 2 || !sameBankCustomerOrigin(previous.origin, verified) || signature(restoredRequest(previous.request)) !== signature(request))) { fail('Cet espace possède déjà une autre demande pour ce mouvement. Les deux copies sont conservées.'); return; }
        try {
          if (!previous) scoped.put({ key, version: 2, origin: verified, request: encoded } satisfies StoredScopedRequest);
          legacy.delete(request.movementId); result(undefined);
        } catch { fail('La copie ancienne ne peut pas être liée à cet espace. Elle reste conservée.'); }
      };
    };
  });
  notify();
}
/** Persist the complete input under a verified origin before any financial call. */
export async function runBankCustomerRequest(request: BankCustomerRequest, expectedWorkspaceScope?: string, signal?: AbortSignal, origin?: BankCustomerRequestOrigin): Promise<string | null> {
  const verified = requireOrigin(origin);
  if (expectedWorkspaceScope !== verified.companyId) throw new Error('L’entreprise ouverte a changé. Rouvrez la demande dans son espace d’origine.');
  requireActive(signal);
  const saved = await retainRequest(request, verified, signal);
  requireActive(signal);
  if (saved.kind === 'create') await desktopApi.createBankCustomerCreditRefund(saved, verified.companyId, signal);
  else if (saved.kind === 'match') await desktopApi.matchBankCustomerCreditRefund(saved.requestId, saved.movementId, saved.refundId, saved.dateDifferenceReason, verified.companyId);
  else await desktopApi.unmatchBankCustomerCreditRefund(saved.requestId, saved.matchId, saved.reason, verified.companyId);
  const cleanupTrace = recordRequestCleanup('start');
  try { await removeBankCustomerRequest(saved, verified); recordRequestCleanup('success', cleanupTrace); return null; }
  catch { recordRequestCleanup('failure', cleanupTrace); return 'L’opération est enregistrée, mais sa demande locale reste à vérifier. Une nouvelle vérification ne créera aucun doublon.'; }
}
