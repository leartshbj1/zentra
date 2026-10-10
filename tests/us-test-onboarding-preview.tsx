import { createRoot } from 'react-dom/client';
import { UsTestOnboarding } from '../components/account/us-test-onboarding';
import { AUTH_CHANGED_EVENT } from '../lib/auth-browser-events';
import { isSiteLanguage } from '../lib/site-language';
import { validateWorkspaceCreationRequest } from '../lib/international/workspace-creation';
import { validateCompanyConfiguration } from '../lib/international/country-config';
import { onboardingActor, onboardingRequestId, onboardingState } from '../lib/international/us-test-onboarding.test-fixtures';
import type { UsTestPublicState } from '../lib/international/us-saas-test-public';
import '../app/compte/account.css';
import '../app/apple-account.css';

// Local-only review fixture. The actual React component runs against synthetic
// in-memory fetch responses. It never calls Auth, a payment provider or a real API.
const query = new URLSearchParams(location.search), selectedLanguage = query.get('lang'), language = isSiteLanguage(selectedLanguage) ? selectedLanguage : 'en', scenario = query.get('scenario');
let state: UsTestPublicState | null = scenario ? onboardingState(scenario === 'reserved' ? 'reserved' : scenario === 'ready' ? 'ready' : 'postgres_confirmed', scenario === 'ready' ? 'ready' : ['pending', 'returned', 'canceled', 'expired'].includes(scenario) ? 'checkout_pending' : 'not_started') : null;
if (state?.purchase.state === 'checkout_pending') state = { ...state, purchase: { ...state.purchase, module: 'gestion', plan: 'synthetic-monthly', ...(scenario === 'expired' ? { expiresAt: Math.floor(Date.now() / 1000) - 1 } : {}) } };
let paid = false, revoked = false, dropCreation = false, dropCheckout = false;
const requests: { path: string; method: string; body: string; status: number }[] = [];
const fixture = {
  scope: 'Local React fixture with synthetic in-memory HTTP responses; no provider, hosted checkout or physical-device claim.', requests,
  setPaid: () => { paid = true; }, dropNextCreation: () => { dropCreation = true; }, dropNextCheckout: () => { dropCheckout = true; },
  expire: () => { if (state) state = { ...state, purchase: { ...state.purchase, expiresAt: Math.floor(Date.now() / 1000) - 1 } }; },
  revoke: () => { revoked = true; window.dispatchEvent(new Event(AUTH_CHANGED_EVENT)); },
};
Object.assign(window, { __US_TEST_ONBOARDING_FIXTURE__: fixture });
window.fetch = async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? init.body : '', record = { path, method, body, status: 0 }; requests.push(record);
  const respond = (value: unknown, status = 200) => { record.status = status; return Response.json(value, { status }); };
  if (revoked || new Headers(init?.headers).get('X-Zentra-Expected-User') !== onboardingActor) return respond({ error: 'session_changed' }, 401);
  if (path === '/api/international/workspaces' && method === 'POST') {
    const request = validateWorkspaceCreationRequest(JSON.parse(body));
    state = { ...onboardingState(), workspace: { ...onboardingState().workspace, requestId: request.requestId, companyName: request.companyName, configuration: validateCompanyConfiguration({ ...request.configuration, organizationId: onboardingState().workspace.organizationId }) } };
    if (dropCreation) { dropCreation = false; record.status = 0; throw new Error('Synthetic lost response'); }
    return respond(state.workspace, 202);
  }
  if (path.startsWith('/api/international/billing/test?') && method === 'GET') {
    if (!state || new URL(path, location.origin).searchParams.get('requestId') !== state.workspace.requestId) return respond({ error: 'not_found' }, 404);
    return respond(state);
  }
  if (path === '/api/international/billing/test' && method === 'POST' && state) {
    const request = JSON.parse(body); if (request.requestId !== state.workspace.requestId || request.module !== 'gestion' || request.plan !== 'synthetic-monthly' || request.confirmTest !== true) return respond({ error: 'invalid_request' }, 422);
    state = { ...state, purchase: { state: 'checkout_pending', module: 'gestion', plan: 'synthetic-monthly', expiresAt: Math.floor(Date.now() / 1000) + 3600 } };
    if (dropCheckout) { dropCheckout = false; return respond({ error: 'checkout_recovery_required' }, 409); }
    return respond({ ...state, checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_LocalFictitiousOnly' });
  }
  if (path === '/api/international/billing/test/recover' && method === 'POST' && state) {
    if (JSON.parse(body).requestId !== state.workspace.requestId) return respond({ error: 'not_found' }, 404);
    if (state.workspace.state === 'reserved') state = { ...state, workspace: { ...state.workspace, state: 'postgres_confirmed', setupStatus: 'us_subscription_required' } };
    else if (state.purchase.state === 'checkout_pending') {
      if (!paid) return respond({ error: state.purchase.expiresAt && state.purchase.expiresAt * 1000 <= Date.now() ? 'checkout_expired' : 'payment_unconfirmed' }, 409);
      state = { ...state, workspace: { ...state.workspace, state: 'ready', setupStatus: 'ready' }, purchase: { state: 'ready', module: 'gestion', plan: 'synthetic-monthly' } };
    }
    return respond(state);
  }
  return respond({ error: 'not_found' }, 404);
};
document.documentElement.lang = language;
createRoot(document.getElementById('root')!).render(<div className="account-experience account-detail" data-theme={query.get('theme') === 'dark' ? 'dark' : 'light'}><main className="account-content preview-content"><UsTestOnboarding expectedUserId={onboardingActor} language={language} initialRequestId={scenario ? onboardingRequestId : query.get('requestId')} checkoutReturn={scenario === 'returned' || scenario === 'canceled' ? scenario : null}/></main></div>);
