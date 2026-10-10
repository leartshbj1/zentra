import { jevRequest, readJevResponse } from '../automation/transport';
import { mailDate, mailRequest, plainMail } from '../support/infomaniak';
import { parseDecision, triageQuestions } from '../support/jev';
import { CATEGORIES, LANGUAGES, PRIORITIES, SupportError } from '../support/types';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { snapshotPrivateJson } from './private-json';
import { validateUsMailboxConnection, type UsMailboxConnection } from './us-support-mailbox-contract';
import {
  US_SUPPORT_TRIAGE_MODEL, US_SUPPORT_TRIAGE_RECIPE_VERSION, UsSupportTriageError,
  validateUsSupportTriageDecision, validateUsSupportTriageGrant,
  validateUsSupportTriageRequest, validateUsSupportTriageSource,
  type UsSupportTriageDecision, type UsSupportTriageGrant,
  type UsSupportTriageRequest, type UsSupportTriageSource,
} from './us-support-triage-contract';

type Check = () => Promise<unknown>;
interface Message { readonly source: UsSupportTriageSource; readonly subject: string; readonly body: string }
const bodyBytes = 16 * 1024;
const controls = /[\p{Cc}\p{Cf}]/u;
const encoder = new TextEncoder();
const invalid = (): never => { throw new UsSupportTriageError('triage_source_unavailable', 422); };
const changed = (): never => { throw new UsSupportTriageError('triage_source_conflict', 409); };
const unavailable = (): never => { throw new UsSupportTriageError('triage_provider_unavailable', 503); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maxBytes: number, empty = false): string {
  if (typeof value !== 'string' || !empty && !value.trim() || encoder.encode(value).byteLength > maxBytes || controls.test(value)) return invalid();
  return value;
}
function bodyText(value: unknown): string {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > bodyBytes) return invalid();
  return value;
}
function segment(value: string): string {
  if (!value || value.length > 200 || /[\s/\\?#%]/u.test(value) || controls.test(value) || value === '.' || value === '..') return invalid();
  return encodeURIComponent(value);
}

/** Cancels the actual upstream reader at the total deadline, including a
 * streaming response whose fetch promise has already resolved. */
function deadlineResponse(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let ended = false;
  let abort: () => void;
  const cleanup = () => signal.removeEventListener('abort', abort);
  const release = () => { try { reader.releaseLock(); } catch { /* A pending read releases after cancellation settles. */ } };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (ended) return;
        ended = true; cleanup(); controller.error(new Error('triage_deadline'));
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
      } catch (error) {
        if (!ended) { ended = true; cleanup(); release(); controller.error(error); }
      }
    },
    async cancel() { ended = true; cleanup(); await reader.cancel().catch(() => undefined); release(); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function withinDeadline<T>(milliseconds: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new UsSupportTriageError('triage_provider_unavailable', 503)); }, milliseconds);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
function guarded(fetcher: typeof fetch, check: Check, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    signal.throwIfAborted(); await check(); signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
    try { await check(); signal.throwIfAborted(); }
    catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    return deadlineResponse(response, signal);
  };
}
function observation(raw: unknown, connection: UsMailboxConnection, request: UsSupportTriageRequest) {
  const value = object(raw);
  if (value.uid !== request.uid + '@' + connection.folderId) return changed();
  if (value.folder_id !== undefined && (typeof value.folder_id !== 'string' && typeof value.folder_id !== 'number' || String(value.folder_id) !== connection.folderId)) return changed();
  const version = typeof value.date === 'number' || typeof value.date === 'string' ? String(value.date) : '';
  if (version !== request.expectedMessageVersion) return changed();
  const receivedAt = mailDate(value.date);
  if (receivedAt === null || !Number.isSafeInteger(receivedAt) || receivedAt <= 0 || receivedAt > 253_402_300_799) return invalid();
  const subject = value.subject === undefined ? '' : text(value.subject, 1024, true);
  const from = value.from === undefined ? [] : value.from;
  if (!Array.isArray(from) || from.length > 100) return invalid();
  const sender = from.map(rawSender => { const s = object(rawSender); return { name: s.name === undefined ? '' : text(s.name, 300, true), email: s.email === undefined ? '' : text(s.email, 254, true) }; });
  const rawAttachments = value.attachments === undefined ? [] : value.attachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 100 || value.has_attachments !== undefined && typeof value.has_attachments !== 'boolean') return invalid();
  const attachments = rawAttachments.map(rawAttachment => {
    const a = object(rawAttachment);
    const size = a.size === undefined ? null : typeof a.size === 'number' ? a.size : typeof a.size === 'string' && /^\d{1,15}$/.test(a.size) ? Number(a.size) : NaN;
    if (size !== null && (!Number.isSafeInteger(size) || size < 0) || a.is_inline !== undefined && typeof a.is_inline !== 'boolean') return invalid();
    return { partId: a.part_id === undefined ? null : typeof a.part_id === 'number' && Number.isSafeInteger(a.part_id) && a.part_id >= 0 ? String(a.part_id) : text(a.part_id, 200),
      resource: a.resource === undefined ? null : text(a.resource, 1200, true), name: a.name === undefined ? '' : text(a.name, 180, true), size,
      mime: a.mime_type === undefined ? null : text(a.mime_type, 120, true), inline: a.is_inline === true };
  });
  // Preserve the selected bounded input literally. No sender prefix, URL
  // expansion, attachment extraction or Automation sanitizeState is applied.
  for (const name of ['body', 'html', 'preview']) if (value[name] !== undefined && value[name] !== null) bodyText(value[name]);
  const bodyKind = typeof value.body === 'string' && value.body.trim() ? 'body' : typeof value.html === 'string' && value.html.trim() ? 'html' : 'preview';
  const rawBody = bodyText(value[bodyKind] ?? '');
  const body = plainMail(rawBody);
  if (!body || encoder.encode(body).byteLength > bodyBytes) return invalid();
  const attachmentCount = Math.max(attachments.length, value.has_attachments === true ? 1 : 0);
  const bodyComplete = bodyKind !== 'preview';
  const material = canonicalErpJson({ provider: connection.provider, mailboxId: connection.mailboxId, folderId: connection.folderId,
    uid: value.uid, version, receivedAt, subject, sender, attachments, hasAttachments: value.has_attachments ?? null, bodyKind, rawBody, body, attachmentCount, bodyComplete });
  return { subject, body, receivedAt, attachmentCount, bodyComplete, material };
}

/** Read-only observations attest to this bounded classifier input. Two reads
 * do not establish UIDVALIDITY or an atomic snapshot of the original mail. */
export function createUsSupportTriageMessageReader(fetcher: typeof fetch = fetch) {
  return async (connection: UsMailboxConnection, token: string, request: UsSupportTriageRequest, check: Check): Promise<Message> => {
    let admissionFailure: unknown;
    const fresh = async () => { try { await check(); } catch (error) { admissionFailure = error; throw error; } };
    try {
      connection = validateUsMailboxConnection(connection); request = validateUsSupportTriageRequest(request);
      if (request.connectionId !== connection.id || request.expectedMailboxRevision !== connection.revision) return changed();
      return await withinDeadline(30_000, async signal => {
        const path = `/mail/${segment(connection.mailboxId)}/folder/${segment(connection.folderId)}/message/${segment(request.uid)}?prefered_format=html&with=auto_uncrypt,thread_context`;
        const transport = guarded(fetcher, fresh, signal);
        const first = observation(await mailRequest(token, path, transport), connection, request); await fresh(); signal.throwIfAborted();
        const second = observation(await mailRequest(token, path, transport), connection, request); await fresh(); signal.throwIfAborted();
        if (first.material !== second.material) return changed();
        const source = validateUsSupportTriageSource({ provider: 'infomaniak', mailboxId: connection.mailboxId, folderId: connection.folderId, uid: request.uid,
          messageVersion: request.expectedMessageVersion, receivedAt: first.receivedAt, messageSha256: await sha256Hex(first.material), attachmentCount: first.attachmentCount, bodyComplete: first.bodyComplete });
        await fresh(); signal.throwIfAborted(); return Object.freeze({ source, subject: first.subject, body: first.body });
      });
    } catch (error) {
      if (admissionFailure !== undefined) throw admissionFailure;
      if (error instanceof UsSupportTriageError) throw error;
      if (error instanceof SupportError && error.status === 422) return invalid();
      return unavailable();
    }
  };
}

function exactResponse(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return unavailable();
  return value as Record<string, unknown>;
}
function strictResponse(raw: unknown) {
  const response = exactResponse(raw, ['model', 'answers', 'usage']);
  if (response.model !== US_SUPPORT_TRIAGE_MODEL) return unavailable();
  const answers = exactResponse(response.answers, ['category', 'priority', 'language', 'frustration', 'human_requested']);
  for (const [name, options] of [['category', CATEGORIES], ['priority', PRIORITIES], ['language', LANGUAGES]] as const) {
    const answer = exactResponse(answers[name], ['type', 'choice', 'confidence', 'probabilities']);
    if (answer.type !== 'choice') return unavailable();
    exactResponse(answer.probabilities, Object.keys(options));
  }
  const frustration = exactResponse(answers.frustration, ['type', 'score', 'confidence', 'probabilities', 'legend']);
  if (frustration.type !== 'score') return unavailable();
  exactResponse(frustration.probabilities, ['0', '1', '2']);
  const legend = exactResponse(frustration.legend, ['0', '1', '2']);
  if (Object.values(legend).some(v => typeof v !== 'string' || encoder.encode(v).byteLength > 1000)) return unavailable();
  const human = exactResponse(answers.human_requested, ['type', 'noul']);
  if (human.type !== 'noul') return unavailable();
  const usage = exactResponse(response.usage, ['input_tokens', 'output_tokens']);
  if (Object.values(usage).some(v => !Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > 10_000_000)) return unavailable();
  // The shared parser validates option membership, finite unit values, sums,
  // winning choices, score consistency and all five typed answers.
  return parseDecision(response, {}, 100);
}

/** One authenticated emission only. Admission/dispatch is supplied by the
 * server's fresh check; this adapter grants no subscription or quota itself. */
export function createUsSupportTriageClassifier(key: string, fetcher: typeof fetch = fetch) {
  return async (message: Message, grant: UsSupportTriageGrant, check: Check): Promise<UsSupportTriageDecision> => {
    let admissionFailure: unknown;
    const fresh = async () => { try { await check(); } catch (error) { admissionFailure = error; throw error; } };
    try {
      const captured = snapshotPrivateJson(message) as Message;
      exactResponse(captured, ['source', 'subject', 'body']);
      const source = validateUsSupportTriageSource(captured.source);
      const subject = text(captured.subject, 1024, true), body = bodyText(captured.body);
      if (!body.trim() || typeof key !== 'string' || !key || encoder.encode(key).byteLength > 8192 || /\s/u.test(key)) return unavailable();
      grant = validateUsSupportTriageGrant(grant);
      if (grant.recipeVersion !== US_SUPPORT_TRIAGE_RECIPE_VERSION) return unavailable();
      return await withinDeadline(8000, async signal => {
        await fresh(); signal.throwIfAborted();
        const response = await jevRequest(key, JSON.stringify(triageQuestions(subject, body)), { fetcher: guarded(fetcher, fresh, signal), timeoutMs: 8000, retry: false });
        await fresh(); signal.throwIfAborted();
        if (!response.ok || response.status >= 300) { void response.body?.cancel().catch(() => undefined); return unavailable(); }
        const raw = JSON.parse(await readJevResponse(response)) as unknown;
        await fresh(); signal.throwIfAborted();
        const decision = strictResponse(raw), signals = decision.signals!;
        const reviewReasons: UsSupportTriageDecision['reviewReasons'][number][] = [];
        if (Math.min(decision.confidence, signals.languageConfidence) < grant.threshold) reviewReasons.push('low_confidence');
        if (signals.humanRequested >= 0.2) reviewReasons.push('human_requested');
        if (decision.category === 'other') reviewReasons.push('other_category');
        if (source.attachmentCount > 0) reviewReasons.push('unread_attachments');
        if (!source.bodyComplete) reviewReasons.push('incomplete_body');
        const result = validateUsSupportTriageDecision({ schemaVersion: 1, category: decision.category, priority: decision.priority,
          categoryConfidence: decision.categoryConfidence, priorityConfidence: decision.priorityConfidence, confidence: decision.confidence,
          language: signals.language, languageConfidence: signals.languageConfidence, humanRequested: signals.humanRequested,
          reviewReasons, needsReview: reviewReasons.length > 0, model: US_SUPPORT_TRIAGE_MODEL, recipeVersion: US_SUPPORT_TRIAGE_RECIPE_VERSION }, { source, grant });
        await fresh(); signal.throwIfAborted(); return result;
      });
    } catch (error) {
      if (admissionFailure !== undefined) throw admissionFailure;
      if (error instanceof UsSupportTriageError) throw error;
      return unavailable();
    }
  };
}
