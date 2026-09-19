// Local HTTP/D1 integration check. Never accepts a remote URL or customer credentials.
const base = 'http://localhost:5295';
const headers = {
  Origin: base,
  'Content-Type': 'application/json',
  Cookie: '__sites_local_auth=1',
};
const call = async (path, body, extra = {}) => {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...headers, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json();
  return { status: res.status, value };
};
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
const create = await call('/api/support', {
  action: 'createWorkspace',
  name: 'QA locale Support',
});
assert(create.status < 300, `create ${create.status}: ${create.value.error}`);
const workspaceId = create.value.workspaceId;
const connect = await call('/api/support', {
  action: 'connect',
  workspaceId,
  provider: 'api',
  label: 'QA locale API',
});
assert(
  connect.status === 201,
  `connect ${connect.status}: ${connect.value.error}`,
);
const hookPath = `/api/support/hooks/${connect.value.connectionId}`,
  auth = { Authorization: `Bearer ${connect.value.hookToken}` };
const send = await call(
  hookPath,
  {
    ticketId: 'qa-local-1',
    subject: 'Bug fictif',
    body: 'Le bouton de cette démonstration ne répond pas.',
  },
  auth,
);
assert(
  send.status === 503 && send.value.error.includes('Jev'),
  'Missing key must be explicit',
);
const loaded = await call('/api/support');
const ticket = loaded.value.tickets.find((t) => t.externalId === 'qa-local-1');
assert(ticket?.state === 'error', 'Ticket must survive model unavailability');
const approve = await call('/api/support', {
  action: 'approve',
  workspaceId,
  ticketId: ticket.id,
  revision: ticket.revision,
  category: 'bug',
  priority: 'normal',
  destination: { teamId: 'support' },
});
assert(approve.status === 200, `manual approval ${approve.status}`);
const decisions = await call(hookPath, undefined, auth);
const decision = decisions.value.decisions.find((t) => t.id === ticket.id);
assert(
  decision?.state === 'ready',
  'Decision must await provider acknowledgment',
);
const ack = await call(
  hookPath,
  {
    action: 'acknowledge',
    ticketId: ticket.id,
    revision: decision.revision,
    status: 'applied',
  },
  auth,
);
assert(ack.status === 200, 'ACK failed');
const confirmed = await call('/api/support');
assert(confirmed.value.counts.routed === 1, 'Routed counter must reflect ACK');
assert(
  !JSON.stringify(confirmed.value).includes(connect.value.hookToken),
  'Webhook secret leaked',
);
const other = await call(`/api/support?workspace=${workspaceId}`, undefined, {
  Cookie: '',
});
assert(other.status === 401, 'Cross-workspace access was not denied');
console.log(
  JSON.stringify({
    result: 'passed',
    realLocalD1: true,
    checks: [
      'creation',
      'connection',
      'retained model error',
      'human approval',
      'API decisions',
      'acknowledgment',
      'counters',
      'secret redaction',
      'tenant isolation',
    ],
  }),
);
