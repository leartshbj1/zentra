// Future live G4 only: actual existing Support API lifecycle, no SQL or provider
// substitution. Human quote classification is explicit and separately reported.
import { createHash, randomUUID } from 'node:crypto';
import { assertCiAdmission, validatePrivateInput } from './verify-action-live-account-windows.mjs';

const ORIGIN = 'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site';
const OWNER = '1f0d9981-607b-4848-9374-587035cdfd89';
const ORG = 'org_trial_345a3d1f68056cf7e709d4af4fc229a4';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const requireValue = (ok, code) => { if (!ok) throw new Error(code); };

// Ordinary Complet checkout may create support_<uuid>; older normal Support
// creation uses a bare UUID. Neither shape conveys any tenant authority.
const workspaceIdentifier = value => typeof value === 'string'
  && UUID.test(value.startsWith('support_') ? value.slice(8) : value);

/** Pure admission for the exact existing paid QA space. The normal Complet
 * checkout owns its creation/linking; this recipe must never create a second
 * workspace or infer ownership from an identifier or a display name. */
export function requirePaidA41Workspace(state, expectedWorkspaceId, linked, empty = false) {
  requireValue(Array.isArray(state?.workspaces) && state.workspaces.length === 1
    && state.workspaces[0]?.role === 'owner' && workspaceIdentifier(state.workspaces[0]?.id)
    && state.workspace?.id === state.workspaces[0].id && state.workspace?.role === 'owner'
    && state.workspace?.canManage === true
    && (expectedWorkspaceId === undefined || state.workspace.id === expectedWorkspaceId), 'g4_exact_owner_support_workspace_required');
  // billing.testMode belongs to optional standalone Support configuration; it
  // may be false for a genuine paid TEST Complet bundle. The fixed A41 origin,
  // compiled profile and preceding native paid-consent checks establish TEST.
  requireValue(state.billing?.active === true && state.billing?.status === 'active' && state.billing?.hasSubscription === true
    && state.billing?.ownerAccess === false && state.billing?.offeredAccess !== true
    && typeof state.billing?.bundlePlan === 'string' && state.billing.bundlePlan.length > 0
    && state.gestion?.organizationId === ORG && state.gestion?.role === 'owner'
    && state.gestion?.linked === linked && state.gestion?.autoPost === false
    && state.automation?.active === linked && typeof state.automation?.enabled === 'boolean'
    && (linked || state.automation.enabled === false), 'g4_exact_paid_complete_delegation_required');
  if (empty) requireValue(Array.isArray(state.tickets) && state.tickets.length === 0
    && Array.isArray(state.connections) && state.connections.length === 0
    && state.focusedTicket === null && state.hasMore === false && state.counts?.total === 0,
  'g4_fictitious_support_workspace_must_be_empty');
  return state.workspace.id;
}

class Cookies {
  #values = new Map();
  constructor(value) {
    for (const pair of value.split('; ')) {
      const i = pair.indexOf('='), name = pair.slice(0, i), content = pair.slice(i + 1);
      requireValue(i > 0 && /^__Host-zentra_[a-z_]+$/.test(name) && /^[\x21-\x7e]+$/.test(content)
        && !/[;,]/.test(content) && !this.#values.has(name), 'g4_cookie_refused');
      this.#values.set(name, content);
    }
    this.owner();
  }
  owner() {
    let owner; try { owner = decodeURIComponent(this.#values.get('__Host-zentra_session_owner') ?? ''); } catch { owner = ''; }
    requireValue(owner === OWNER && this.#values.get('__Host-zentra_access') && this.#values.get('__Host-zentra_refresh'), 'g4_owner_cookie_required');
  }
  absorb(response) {
    requireValue(typeof response.headers.getSetCookie === 'function', 'g4_modern_cookie_reader_required');
    for (const header of response.headers.getSetCookie()) {
      const parts = header.split(';').map(x => x.trim()), i = parts[0].indexOf('=');
      const name = parts[0].slice(0, i), value = parts[0].slice(i + 1);
      if (!name.startsWith('__Host-zentra_')) continue;
      const attrs = new Map(parts.slice(1).map(x => { const split = x.indexOf('='); return split < 0 ? [x.toLowerCase(), ''] : [x.slice(0, split).toLowerCase(), x.slice(split + 1)]; }));
      requireValue(i > 0 && /^__Host-zentra_[a-z_]+$/.test(name) && /^[\x21-\x7e]*$/.test(value) && !/[;,]/.test(value)
        && !attrs.has('domain') && attrs.get('path') === '/' && attrs.has('secure') && attrs.has('httponly')
        && attrs.get('samesite')?.toLowerCase() === 'lax', 'g4_cookie_response_refused');
      if (!value || (attrs.has('max-age') && Number(attrs.get('max-age')) <= 0)) this.#values.delete(name);
      else this.#values.set(name, value);
    }
    this.owner();
  }
  header() { return [...this.#values].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function json(response) {
  requireValue(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json' && response.body, 'g4_support_json_required');
  const reader = response.body.getReader(), chunks = []; let count = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength;
      requireValue(count <= 1024 * 1024, 'g4_support_response_size_refused'); chunks.push(Buffer.from(part.value)); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error('g4_support_json_invalid'); }
  } finally { await reader.cancel().catch(() => {}); }
}

export function makeRealApiSupportSource(rawInput) {
  const input = validatePrivateInput(rawInput); let result, attempted = false;
  return {
    async provision(seed) {
      assertCiAdmission({ ...process.env });
      requireValue(process.env.ZENTRA_RUN_LIVE_G4_RECIPE === 'true'
        && !['ad57c6905112462bbf844c8bb89072d488294f2c','b50214696754365b3f4b9d889bfefd0d3816e36a'].includes(process.env.CIRCLE_SHA1), 'g4_future_ci_source_required');
      requireValue(!attempted && seed.organizationId === ORG && UUID.test(seed.customerId ?? '') && UUID.test(seed.articleId ?? ''), 'g4_single_real_source_required');
      attempted = true;
      const jar = new Cookies(seed.browserCookieHeader);
      async function request(route, body, hookToken) {
        const url = new URL(route, ORIGIN);
        requireValue(url.origin === ORIGIN && !url.username && !url.password && !url.hash
          && (url.pathname === '/api/auth/session' || url.pathname === '/api/support'
            || /^\/api\/support\/hooks\/[0-9a-f-]{36}$/.test(url.pathname)), 'g4_support_route_refused');
        const headers = { accept: 'application/json', 'oai-sites-authorization': `Bearer ${input.sitesServiceToken}` };
        if (hookToken) headers.authorization = `Bearer ${hookToken}`;
        else { headers.cookie = jar.header(); headers.origin = ORIGIN; }
        if (body) headers['content-type'] = 'application/json';
        let response;
        try { response = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
          redirect: 'error', signal: AbortSignal.timeout(30000) }); }
        catch { throw new Error('g4_support_network_failed'); }
        // An expected unprocessed API source returns202. No failing response is
        // inspected as successful persistence, even if it might have written.
        requireValue([200, 201, 202].includes(response.status), 'g4_support_http_refused');
        if (!hookToken) jar.absorb(response);
        return { status: response.status, value: await json(response) };
      }
      const auth = (await request('/api/auth/session')).value;
      requireValue(auth?.authenticated === true && auth.user?.id === OWNER && auth.user?.emailConfirmed === true, 'g4_support_browser_owner_refused');
      const before = (await request('/api/support')).value;
      // Paid Complet normally already created and linked this owner's space.
      // Reuse only that exact empty QA space; never clear existing work or move
      // a link. A partial previous run requires explicit review before retry.
      const workspaceId = requirePaidA41Workspace(before, undefined, true, true);
      const stateRoute = `/api/support?workspace=${workspaceId}`;
      let state = (await request(stateRoute)).value;
      requirePaidA41Workspace(state, workspaceId, true, true);
      const sourceAutomationEnabled = before.automation.enabled;
      requireValue(state.automation.enabled === sourceAutomationEnabled, 'g4_support_settings_changed');
      // If classification is already opted in, temporarily pause ONLY this
      // verified QA delegation through its normal authorized API. If it is off,
      // preserve that setting and link. No entitlement/settings are inserted.
      const envelope = { ticketId: `a41-g4-${randomUUID()}`, subject: 'Devis pour trois radiateurs A41',
        body: 'Merci de préparer un devis pour trois radiateurs, référence A41-RAD-100.',
        senderEmail: 'camille-a41@example.invalid', senderName: 'Camille Recette A41', version: 'a41-g4-api-v1' };
      let ticket, connectionId;
      try {
        // Enter the finally scope BEFORE this mutation: an unavailable response
        // may still have paused the link on the server.
        if (sourceAutomationEnabled) await request('/api/support', { action: 'linkGestion', workspaceId, organizationId: ORG, enabled: false, autoPost: false });
        state = (await request(stateRoute)).value;
        requirePaidA41Workspace(state, workspaceId, !sourceAutomationEnabled, true);
        requireValue(state.automation.enabled === false, 'g4_support_classification_must_be_inactive');
        await request('/api/support', { action: 'settings', workspaceId, name: 'Recette G4 A41 fictive', mode: 'review', threshold: 85, baselineSeconds: 60 });
        const connection = await request('/api/support', { action: 'connect', workspaceId, provider: 'api', label: 'Recette G4 A41 API' });
        connectionId = connection.value.connectionId;
        const hookToken = connection.value.hookToken;
        requireValue(connection.status === 201 && UUID.test(connectionId ?? '') && /^zsup_[A-Za-z0-9_-]{43}$/.test(hookToken ?? ''), 'g4_real_api_connection_required');
        // Exact delegation is paused, or the existing setting is already off.
        // Human approval is an actual paid API operation, not a model result.
        // The later Action Engine still calls the real JEV preparation provider;
        // this separate source lifecycle neither proves nor replaces that call.
        const received = await request(`/api/support/hooks/${connectionId}`, envelope, hookToken);
        ticket = received.value.ticket;
        requireValue(received.status === 202 && UUID.test(ticket?.id ?? '') && ticket.connectionId === connectionId
          && ticket.externalId === envelope.ticketId && ticket.state === 'pending' && ticket.decision === null
          && ticket.senderEmail === envelope.senderEmail && Number.isSafeInteger(ticket.revision) && ticket.revision >= 1
          && received.value.automationRequired === sourceAutomationEnabled, 'g4_real_pending_api_source_required');
        await request('/api/support', { action: 'approve', workspaceId, ticketId: ticket.id, revision: ticket.revision,
          category: 'quote', priority: 'normal', destination: { teamId: 'support' } });
        state = (await request(`${stateRoute}&ticket=${ticket.id}`)).value;
        requireValue(state.focusedTicket?.id === ticket.id && state.focusedTicket?.revision === ticket.revision + 1
          && state.focusedTicket?.state === 'ready'
          && state.focusedTicket?.decision?.category === 'quote' && state.focusedTicket?.decision?.manual === true,
        'g4_real_human_quote_classification_required');
      } finally {
        // Compensate even a failed/unknown pause response, using fresh ordinary
        // authorization. A changed tenant, lost access or unavailable server
        // refuses restoration rather than bypassing its checks or claiming it.
        if (sourceAutomationEnabled) try {
          const current = (await request(stateRoute)).value;
          requireValue(typeof current.gestion?.linked === 'boolean', 'g4_delegation_state_required');
          requirePaidA41Workspace(current, workspaceId, current.gestion.linked);
          if (!current.gestion.linked) await request('/api/support', { action: 'linkGestion', workspaceId,
            organizationId: ORG, enabled: true, autoPost: false });
          requirePaidA41Workspace((await request(stateRoute)).value, workspaceId, true);
        } catch { throw new Error('g4_delegation_restore_unconfirmed'); }
      }
      state = (await request(`${stateRoute}&ticket=${ticket.id}`)).value;
      requirePaidA41Workspace(state, workspaceId, true);
      requireValue(state.automation.enabled === sourceAutomationEnabled, 'g4_support_settings_changed');
      requireValue(state.focusedTicket?.id === ticket.id && state.focusedTicket?.state === 'ready'
        && state.focusedTicket?.revision === ticket.revision + 1
        && state.focusedTicket?.decision?.category === 'quote' && state.focusedTicket?.decision?.manual === true,
      'g4_real_delegated_human_quote_required');
      result = { workspaceId, connectionId, sourceId: ticket.id, sourceRevision: state.focusedTicket.revision,
        sourceEnvelopeSha256: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'),
        actualApiHookPersisted: true, actualHumanQuoteClassification: true, actualGestionDelegation: true,
        automaticSupportClassificationExecuted: false, thirdPartyMailboxExecuted: false };
      return { sourceId: ticket.id };
    },
    publicProof() { requireValue(result, 'g4_source_lifecycle_not_complete'); return { ...result }; },
  };
}
