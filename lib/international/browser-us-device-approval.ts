import { normalizeUserCode } from '../account-security';
import { readJsonObjectWithinLimit } from '../request-body';
import { US_DEVICE_PROTOCOL } from './us-device-protocol';
import { usDeviceDisplayText } from './us-device-display-text';

export interface UsDeviceApprovalScope { readonly userId: string; readonly organizationIds: readonly string[]; readonly initialCode: string }
export interface UsDeviceApprovalView { readonly code: string; readonly organizationId: string; readonly busy: boolean; readonly approvedName: string | null; readonly error: string | null }
type Transport = (request: Request) => Promise<Response>;
const codes = new Set(['invalid_request','authorization_expired','authorization_conflict','unauthorized','session_changed','forbidden','management_entitlement_required','seat_limit_reached','feature_unavailable','rate_limited','service_unavailable']);
export class UsDeviceApprovalModel {
  private view: UsDeviceApprovalView;
  private readonly ids: ReadonlySet<string>;
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private pending: AbortController | null = null;
  constructor(readonly scope: UsDeviceApprovalScope, private readonly transport: Transport = request => fetch(request), private readonly origin = 'https://zentraapp.ch') {
    this.ids = new Set(scope.organizationIds);
    let code = ''; try { code = normalizeUserCode(scope.initialCode); } catch { /* Manual entry remains available. */ }
    this.view = Object.freeze({ code, organizationId: '', busy: false, approvedName: null, error: null });
  }
  getSnapshot = (): UsDeviceApprovalView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(values: Partial<UsDeviceApprovalView>) { if (this.disposed) return; this.view = Object.freeze({ ...this.view, ...values }); for (const listener of this.listeners) listener(); }
  code(value: string) { if (!this.view.busy && !this.view.approvedName) this.update({ code: value.slice(0,32).toUpperCase(), error: null }); }
  choose(id: string) { if (!this.view.busy && !this.view.approvedName) this.update({ organizationId: this.ids.has(id) ? id : '', error: null }); }
  invalidate() { this.disposed = true; this.pending?.abort(); this.listeners.clear(); }
  async approve(): Promise<void> {
    if (this.disposed || this.view.busy || this.view.approvedName) return;
    let userCode: string; try { userCode = normalizeUserCode(this.view.code); } catch { this.update({ error: 'invalid_request' }); return; }
    const organizationId = this.view.organizationId;
    if (!this.ids.has(organizationId)) { this.update({ error: 'forbidden' }); return; }
    const pending = new AbortController(); this.pending = pending;
    let onAbort: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('service_unavailable'));
      pending.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => pending.abort(), 15_000);
    this.update({ busy: true, error: null });
    try {
      const operation = async () => {
        const response = await this.transport(new Request(new URL('/api/international/device/approve', this.origin), { method: 'POST', credentials: 'same-origin', signal: pending.signal, headers: { 'Content-Type': 'application/json', 'X-Zentra-Expected-User': this.scope.userId }, body: JSON.stringify({ protocol: US_DEVICE_PROTOCOL, userCode, organizationId }) }));
        if (pending.signal.aborted) throw new Error('service_unavailable');
        const body = await readJsonObjectWithinLimit(response, 4096);
        return { response, body };
      };
      // A stalled transport/body cannot keep the button busy indefinitely,
      // including test transports which ignore AbortSignal.
      const { response, body } = await Promise.race([operation(), deadline]);
      if (this.disposed || pending.signal.aborted) return;
      if (!response.ok) {
        if (Object.keys(body).length !== 1 || typeof body.error !== 'string' || !codes.has(body.error)) throw new Error('service_unavailable');
        throw new Error(body.error);
      }
      const keys = ['protocol','approved','organizationId','organizationName','country','currency'];
      if (Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key)) || body.protocol !== US_DEVICE_PROTOCOL || body.approved !== true || body.organizationId !== organizationId || body.country !== 'US' || body.currency !== 'USD' || !usDeviceDisplayText(body.organizationName,160)) throw new Error('service_unavailable');
      this.update({ approvedName: body.organizationName });
    } catch (error) { if (!this.disposed) this.update({ error: error instanceof Error && codes.has(error.message) ? error.message : 'service_unavailable' }); }
    finally { clearTimeout(timer); pending.signal.removeEventListener('abort', onAbort); if (this.pending === pending) this.pending = null; this.update({ busy: false }); }
  }
}
