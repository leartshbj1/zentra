import { desktopApi } from './bridge';

type RequestContext = { requestId: string; movementId: string; description: string; amountCents: number; currency: string; date: string };
export type BankCustomerRequest = RequestContext & (
  | { kind: 'create'; customerCreditNoteId: string; reference: string; reason: string; receipt: File | null }
  | { kind: 'match'; refundId: string; dateDifferenceReason?: string }
  | { kind: 'unlink'; matchId: string; reason: string }
);
type StoredReceipt = { name: string; type: string; lastModified: number; bytes: ArrayBuffer };
type StoredRequest = Exclude<BankCustomerRequest, { kind: 'create' }> | (Omit<Extract<BankCustomerRequest, { kind: 'create' }>, 'receipt'> & { receipt: StoredReceipt | File | null });
function restoredRequest(request: StoredRequest): BankCustomerRequest {
  if (request.kind !== 'create' || !request.receipt || request.receipt instanceof File) return request as BankCustomerRequest;
  const { bytes, name, type, lastModified } = request.receipt;
  return { ...request, receipt: new File([bytes], name, { type, lastModified }) };
}
export const BANK_CUSTOMER_REQUEST_EVENT = 'zentra:bank-customer-request';
let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Le stockage de reprise est indisponible sur cet appareil.')); return; }
    const request = indexedDB.open('zentra-bank-customer-requests', 1);
    let settled = false;
    request.onupgradeneeded = () => { request.result.createObjectStore('requests', { keyPath: 'movementId' }); };
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
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void, fail: (message: string) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('requests', mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(new Error('Impossible de conserver la demande. Aucun nouvel enregistrement ne sera envoyé sans une copie de reprise.'));
    action(tx.objectStore('requests'), value => { result = value; }, message => { reject(new Error(message)); tx.abort(); });
  });
}
const notify = () => window.dispatchEvent(new Event(BANK_CUSTOMER_REQUEST_EVENT));
export async function listBankCustomerRequests(): Promise<BankCustomerRequest[]> {
  const rows = await transaction<StoredRequest[]>('readonly', (store, result) => { const request = store.getAll(); request.onsuccess = () => result(request.result); });
  return rows.map(restoredRequest);
}
function signature(request: BankCustomerRequest): string {
  return JSON.stringify(request.kind === 'create' ? { ...request, receipt: request.receipt ? { name: request.receipt.name, size: request.receipt.size, type: request.receipt.type, lastModified: request.receipt.lastModified } : null } : request);
}
async function retainRequest(request: BankCustomerRequest): Promise<BankCustomerRequest> {
  // Binary buffers also work on WebKit versions that cannot persist File/Blob values.
  // Read the file before opening the transaction; awaiting here must not expire a transaction.
  const encoded: StoredRequest = request.kind === 'create' && request.receipt
    ? { ...request, receipt: { name: request.receipt.name, type: request.receipt.type, lastModified: request.receipt.lastModified, bytes: await request.receipt.arrayBuffer() } }
    : request;
  const saved = await transaction<BankCustomerRequest>('readwrite', (store, result, fail) => {
    const existing = store.get(request.movementId);
    existing.onsuccess = () => {
      const previous = existing.result ? restoredRequest(existing.result) : undefined;
      if (previous) {
        if (signature(previous) !== signature(request)) { fail('Une demande est déjà conservée pour ce mouvement. Vérifiez-la dans « Demandes à vérifier » avant de changer le choix.'); return; }
        result(previous); return;
      }
      try { store.put(encoded); result(request); }
      catch { fail('Le justificatif et la demande ne peuvent pas être conservés sur cet appareil. La vérification n’a pas démarré.'); }
    };
  });
  notify();
  return saved;
}
export async function removeBankCustomerRequest(request: BankCustomerRequest): Promise<void> {
  await transaction<void>('readwrite', (store, result, fail) => {
    const existing = store.get(request.movementId);
    existing.onsuccess = () => {
      if (existing.result && existing.result.requestId !== request.requestId) { fail('La demande conservée a changé. Actualisez la liste.'); return; }
      store.delete(request.movementId); result(undefined);
    };
  });
  notify();
}
/** Persist the complete input, including the optional file, before any financial call. */
export async function runBankCustomerRequest(request: BankCustomerRequest): Promise<string | null> {
  const saved = await retainRequest(request);
  if (saved.kind === 'create') await desktopApi.createBankCustomerCreditRefund(saved);
  else if (saved.kind === 'match') await desktopApi.matchBankCustomerCreditRefund(saved.requestId, saved.movementId, saved.refundId, saved.dateDifferenceReason);
  else await desktopApi.unmatchBankCustomerCreditRefund(saved.requestId, saved.matchId, saved.reason);
  try { await removeBankCustomerRequest(saved); return null; }
  catch { return 'L’opération est enregistrée, mais sa demande locale reste à vérifier. Une nouvelle vérification ne créera aucun doublon.'; }
}
