import { mailDate, mailRequest, MAIL_PAGE_SIZE } from '../support/infomaniak';
import { SupportError } from '../support/types';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { validateUsMailboxConnection, type UsMailboxConnection } from './us-support-mailbox-contract';
import { UsSupportTriageError } from './us-support-triage-contract';

type Check = () => Promise<unknown>;
export interface UsSupportIntakeReference {
  readonly uid: string;
  /** Only the message's own date can be a version hint. A thread date is not. */
  readonly versionHint: string | null;
  readonly receivedAt: number | null;
}
export interface UsSupportIntakeDiscoveryIssue {
  readonly code: 'invalid_reference' | 'missing_messages' | 'wrong_folder' | 'oversized_thread';
  readonly threadIndex: number;
  readonly messageIndex: number | null;
  readonly fingerprint: string;
}
export interface UsSupportIntakeDiscovery {
  readonly offset: number;
  readonly threadCount: number;
  readonly nextOffset: number | null;
  readonly references: readonly UsSupportIntakeReference[];
  readonly issues: readonly UsSupportIntakeDiscoveryIssue[];
}
export interface UsSupportIntakeScan { readonly offset: number; readonly sinceAt: number }
const controls = /[\p{Cc}\p{Cf}]/u;
const deadlineMs = 12_000;
const maxThreadMessages = 50;
const unavailable = (): never => { throw new UsSupportTriageError('intake_provider_unavailable', 503); };
const invalid = (): never => { throw new UsSupportTriageError('invalid_intake_request', 422); };
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function segment(value: string): string {
  if (!value || value.length > 200 || /[\s/\\?#%]/u.test(value) || controls.test(value) || value === '.' || value === '..') return invalid();
  return encodeURIComponent(value);
}
function version(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!text || text.length > 200 || text.trim() !== text || controls.test(text)) return null;
  return receivedAt(value) === null ? null : text;
}
function receivedAt(value: unknown): number | null {
  const result = mailDate(value);
  return result !== null && Number.isSafeInteger(result) && result > 0 && result <= 253_402_300_799 ? result : null;
}
function uid(value: unknown, folderId: string): string | null {
  if (typeof value !== 'string' || !value.endsWith('@' + folderId)) return null;
  const part = value.slice(0, -folderId.length - 1);
  return /^\d{1,20}$/.test(part) ? part : null;
}
function folderMatches(value: unknown, folderId: string): boolean {
  return value === undefined || (typeof value === 'string' || typeof value === 'number') && String(value) === folderId;
}
/** A fetch response may already have resolved when the total deadline expires.
 * Cancel its actual reader as well as the transport signal. */
function boundedResponse(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let ended = false;
  let abort: () => void;
  const cleanup = () => signal.removeEventListener('abort', abort);
  const release = () => { try { reader.releaseLock(); } catch { /* Pending cancellation releases the lock afterwards. */ } };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (ended) return;
        ended = true; cleanup(); controller.error(new Error('intake_deadline'));
        void reader.cancel().catch(() => undefined).finally(release);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const part = await reader.read();
        if (ended) return;
        if (part.done) { ended = true; cleanup(); release(); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) { if (!ended) { ended = true; cleanup(); release(); controller.error(error); } }
    },
    async cancel() { ended = true; cleanup(); await reader.cancel().catch(() => undefined); release(); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function run<T>(fetcher: typeof fetch, check: Check, operation: (transport: typeof fetch, fresh: Check) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let admissionFailure: unknown, timer: ReturnType<typeof setTimeout> | undefined;
  const fresh = async () => {
    controller.signal.throwIfAborted();
    try { await check(); } catch (error) { admissionFailure = error; throw error; }
    controller.signal.throwIfAborted();
  };
  const transport: typeof fetch = async (input, init) => {
    await fresh();
    const response = await fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
    try { await fresh(); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    return boundedResponse(response, controller.signal);
  };
  try {
    return await Promise.race([
      (async () => { await fresh(); const result = await operation(transport, fresh); await fresh(); return result; })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new UsSupportTriageError('intake_provider_unavailable', 503)); }, deadlineMs); }),
    ]);
  } catch (error) {
    if (admissionFailure !== undefined) throw admissionFailure;
    if (error instanceof UsSupportTriageError) throw error;
    if (error instanceof SupportError && error.status === 422) throw new UsSupportTriageError('intake_source_unavailable', 422);
    return unavailable();
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

/** Provider offsets count threads, never the number of returned message UIDs.
 * This API supplies no snapshot cursor/UIDVALIDITY. Reconciliation and durable
 * receipts belong to the service; no message body, sender or attachment is kept. */
export function createUsSupportIntakeProvider(fetcher: typeof fetch = fetch) {
  return {
    async discover(connectionInput: UsMailboxConnection, token: string, scan: UsSupportIntakeScan, check: Check): Promise<UsSupportIntakeDiscovery> {
      const connection = validateUsMailboxConnection(connectionInput), input = object(scan);
      if (!input || Object.keys(input).sort().join(',') !== 'offset,sinceAt' || !Number.isSafeInteger(input.offset) || Number(input.offset) < 0
        || Number(input.offset) % MAIL_PAGE_SIZE !== 0 || Number(input.offset) > Number.MAX_SAFE_INTEGER - MAIL_PAGE_SIZE
        || !Number.isSafeInteger(input.sinceAt) || Number(input.sinceAt) < 1 || Number(input.sinceAt) > 253_402_300_799) return invalid();
      const offset = Number(input.offset), sinceAt = Number(input.sinceAt);
      const params = new URLSearchParams({ offset: String(offset), thread: 'off', severywhere: '0', limit: String(MAIL_PAGE_SIZE),
        // Coarse search only. Exact eligibility must be corroborated against the
        // observed message; this is never an advancing date high-water mark.
        sfromdate: `${new Date((sinceAt - 86400) * 1000).toISOString().slice(0, 10)} 00:00:00` });
      const path = `/mail/${segment(connection.mailboxId)}/folder/${segment(connection.folderId)}/message?${params}`;
      return run(fetcher, check, async (transport, fresh) => {
        const data = object(await mailRequest(token, path, transport)); await fresh();
        if (!data || !Array.isArray(data.threads) || data.threads.length > MAIL_PAGE_SIZE) return unavailable();
        const references: UsSupportIntakeReference[] = [], issues: UsSupportIntakeDiscoveryIssue[] = [];
        const seen = new Map<string, UsSupportIntakeReference>();
        async function issue(code: UsSupportIntakeDiscoveryIssue['code'], threadIndex: number, messageIndex: number | null, raw: unknown) {
          const fingerprint = await sha256Hex(canonicalErpJson(raw)); await fresh();
          issues.push(Object.freeze({ code, threadIndex, messageIndex, fingerprint }));
        }
        for (const [threadIndex, rawThread] of data.threads.entries()) {
          const thread = object(rawThread);
          if (!thread || !Array.isArray(thread.messages) || !thread.messages.length) { await issue('missing_messages', threadIndex, null, rawThread); continue; }
          if (thread.messages.length > maxThreadMessages) { await issue('oversized_thread', threadIndex, null, rawThread); continue; }
          for (const [messageIndex, rawMessage] of thread.messages.entries()) {
            const message = object(rawMessage), messageUid = uid(message?.uid, connection.folderId);
            if (!message || messageUid === null) { await issue('invalid_reference', threadIndex, messageIndex, rawMessage); continue; }
            if (!folderMatches(message.folder_id, connection.folderId)) { await issue('wrong_folder', threadIndex, messageIndex, rawMessage); continue; }
            const reference = Object.freeze({ uid: messageUid, versionHint: version(message.date), receivedAt: receivedAt(message.date ?? thread.date) });
            const previous = seen.get(messageUid);
            if (previous) {
              if (previous.versionHint !== reference.versionHint || previous.receivedAt !== reference.receivedAt) await issue('invalid_reference', threadIndex, messageIndex, rawMessage);
              continue;
            }
            seen.set(messageUid, reference); references.push(reference);
          }
        }
        return Object.freeze({ offset, threadCount: data.threads.length, nextOffset: data.threads.length === MAIL_PAGE_SIZE ? offset + MAIL_PAGE_SIZE : null,
          references: Object.freeze(references), issues: Object.freeze(issues) });
      });
    },
    /** One strict private observation resolves only the version/date. H3a still
     * performs its two bounded observations before reserving any inference. */
    async resolveVersion(connectionInput: UsMailboxConnection, token: string, messageUid: string, check: Check): Promise<{ readonly messageVersion: string; readonly receivedAt: number }> {
      const connection = validateUsMailboxConnection(connectionInput);
      if (typeof messageUid !== 'string' || !/^\d{1,20}$/.test(messageUid)) return invalid();
      const path = `/mail/${segment(connection.mailboxId)}/folder/${segment(connection.folderId)}/message/${segment(messageUid)}?prefered_format=html&with=auto_uncrypt,thread_context`;
      return run(fetcher, check, async (transport, fresh) => {
        const data = object(await mailRequest(token, path, transport)); await fresh();
        if (!data || data.uid !== messageUid + '@' + connection.folderId || !folderMatches(data.folder_id, connection.folderId)) throw new UsSupportTriageError('intake_source_conflict', 409);
        const messageVersion = version(data.date), observedAt = receivedAt(data.date);
        if (messageVersion === null || observedAt === null) throw new UsSupportTriageError('intake_source_unavailable', 422);
        return Object.freeze({ messageVersion, receivedAt: observedAt });
      });
    },
  };
}
