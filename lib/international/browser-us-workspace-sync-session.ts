import type { AccountRole } from '../account-security';
import { BrowserErpError } from './browser-erp-session';
import { ERP_SCHEMA_HEADER, type ErpSchemaVersion } from './erp-schema-capability';
import { validateUsWorkspaceSyncHeads, type UsWorkspaceSyncHeads } from './us-workspace-sync-heads';

export class BrowserUsWorkspaceSyncError extends BrowserErpError {
  constructor(code: string, status: number, outcome: 'rejected' | 'unauthorized' = 'rejected', readonly retryAfterMs = 0) { super(code, status, outcome); this.name = 'BrowserUsWorkspaceSyncError'; }
}
export interface BrowserUsWorkspaceSyncSessionOptions {
  organizationId: string;
  expectedUserId: string;
  role: AccountRole;
  supportedSchemaVersion?: ErpSchemaVersion;
  fetch?: typeof globalThis.fetch;
}
export interface BrowserUsWorkspaceSyncSession { load(): Promise<UsWorkspaceSyncHeads>; dispose(): void; }
const codes = new Set(['unauthorized', 'session_changed', 'tenant_mismatch', 'forbidden', 'management_entitlement_required', 'financial_permission_required', 'country_configuration_required', 'configuration_changed', 'feature_unavailable', 'edition_unavailable', 'client_upgrade_required', 'workspace_unavailable', 'service_unavailable', 'invalid_request', 'rate_limited']);
const maximumBytes = 4_096, deadlineMs = 8_000;
function fail(code = 'invalid_response', status = 503, outcome: 'rejected' | 'unauthorized' = 'rejected', retry = 0): never { throw new BrowserUsWorkspaceSyncError(code, status, outcome, retry); }

/** Read-only compact hints. They never grant access or authorize a mutation. */
export function createBrowserUsWorkspaceSyncSession(options: BrowserUsWorkspaceSyncSessionOptions): BrowserUsWorkspaceSyncSession {
  const capability = options.supportedSchemaVersion ?? 1;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.organizationId) || !options.expectedUserId || options.expectedUserId.trim() !== options.expectedUserId || options.expectedUserId.length > 256 || Array.from(options.expectedUserId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(options.role) || ![1, 2, 3, 4].includes(capability)) fail('invalid_request', 422);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), controllers = new Set<AbortController>();
  let disposed = false, sequence = 0;
  function alive() { if (disposed) fail('session_disposed', 0, 'unauthorized'); }
  function dispose() { if (disposed) return; disposed = true; sequence++; for (const controller of controllers) controller.abort(); controllers.clear(); }
  return {
    async load() {
      alive(); const started = ++sequence, controller = new AbortController(); controllers.add(controller);
      let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new BrowserUsWorkspaceSyncError('response_timeout', 0)); }, deadlineMs); });
      try {
        const response = await Promise.race([fetcher(`/api/international/workspaces/${encodeURIComponent(options.organizationId)}/sync-heads`, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', 'X-Zentra-Expected-User': options.expectedUserId, [ERP_SCHEMA_HEADER]: String(capability) } }), deadline]);
        alive();
        if ([401, 402, 403].includes(response.status)) { dispose(); fail(response.status === 401 ? 'unauthorized' : response.status === 402 ? 'management_entitlement_required' : 'forbidden', response.status, 'unauthorized'); }
        const declared = response.headers.get('Content-Length'); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) { controller.abort(); fail(); }
        const reader = response.body?.getReader(); if (!reader) fail();
        const chunks: Uint8Array[] = []; let bytes = 0, finished = false;
        try {
          while (true) { const chunk = await Promise.race([reader.read(), deadline]); alive(); if (chunk.done) { finished = true; break; } bytes += chunk.value.byteLength; if (bytes > maximumBytes) { controller.abort(); fail(); } chunks.push(chunk.value); }
        } finally { if (!finished) void reader.cancel().catch(() => {}); reader.releaseLock(); }
        const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); } catch { fail(); }
        alive(); if (started !== sequence) fail('stale_read', 0);
        if (!response.ok) {
          const input = raw as { error?: unknown }, code = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1 && typeof input.error === 'string' && codes.has(input.error) ? input.error : 'service_unavailable';
          const retry = response.headers.get('Retry-After'), delay = retry && /^\d+$/.test(retry) ? Math.min(Number(retry) * 1_000, 300_000) : 0;
          fail(code, response.status, 'rejected', Number.isSafeInteger(delay) ? delay : 0);
        }
        let result: UsWorkspaceSyncHeads; try { result = validateUsWorkspaceSyncHeads(raw, options.organizationId, capability); } catch { fail(); }
        if (result.role !== options.role) { dispose(); fail('session_changed', 401, 'unauthorized'); }
        return result;
      } catch (error) {
        if (error instanceof BrowserErpError && error.outcome === 'unauthorized') throw error;
        alive(); if (error instanceof BrowserErpError) throw error;
        fail(timedOut ? 'response_timeout' : 'response_unavailable', 0);
      } finally { if (timer !== undefined) clearTimeout(timer); controllers.delete(controller); }
    },
    dispose,
  };
}
