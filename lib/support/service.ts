import { getZentraUser, type ZentraUser } from '@/app/zentra-auth';
import { database, runtimeValue } from '@/lib/runtime';
import { enforceAccountRateLimit, normalizedEmail } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import {
  readJsonObjectWithinLimit,
  RequestBodyError,
} from '@/lib/request-body';
import { publicSiteUrl } from '@/lib/site-url';
import {
  encryptSecret,
  decryptSecret,
  digest,
  equalHash,
  newHookToken,
} from './crypto';
import {
  evaluateTicket,
  verifyPlatformApiKey,
  canAutomaticallyRoute,
  TRIAGE_POLICY_VERSION,
} from './jev';
import {
  zendeskAvailability,
  configureZendesk,
  startZendesk,
  zendeskSecret,
  completeZendesk,
} from './zendesk-oauth';
import { hasAdminSession } from './admin-session';
import { connectMailbox, mailboxStates, syncMailbox, refreshMailboxTicket } from './mail-sync';
import { MAIL_DIRECTORY, mailConnection } from './infomaniak';
import { mailAnalysisBody } from './mail-documents';
import { gestionLinkState, saveGestionLink } from '@/lib/supplier-inbox/service';
import { attachSupportAccess } from './founder-access';
import {
  rememberSupportOwner,
  cancelSupportCheckout,
  billingState,
  supportBillingAdminState,
  provisionSupportBilling,
  verifySupportBilling,
  createSupportCheckout,
  createSupportPortal,
  refreshSupportPayment,
  requireSupportSubscription,
  reserveAnalysis,
  finishAnalysis,
} from './billing';
import { evaluateCalibration, type CalibrationReport } from './calibration';
import { evaluationTickets, evaluateTestBatch, evaluationDocuments, evaluateDocumentBatch } from './evaluation';
import {
  loadDirectory,
  providerDomain,
  readProviderTicket,
  assignProviderTicket,
} from './connectors';
import {
  CATEGORIES,
  PRIORITIES,
  SupportError,
  record,
  text,
  externalId,
  type Connection,
  type Decision,
  type Destination,
  type Directory,
  type Provider,
  type Rules,
  type SourceTicket,
  type Ticket,
  type Workspace,
} from './types';

const now = () => Math.floor(Date.now() / 1000);
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
export function supportJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers });
}
export function supportError(error: unknown) {
  const known =
    error instanceof SupportError ||
    error instanceof RequestBodyError ||
    error instanceof AccountPublicError;
  if (!known)
    console.error('support_request_failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
  return supportJson(
    {
      error: known
        ? error.message
        : 'Le service support est momentanément indisponible. Votre travail est conservé.',
    },
    known ? error.status : 500,
  );
}
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin)
    throw new SupportError('Rechargez cette page avant de réessayer.', 403);
}
function platformOwner(user: ZentraUser) {
  return (
    (!!runtimeValue('OWNER_ACCOUNT_USER_ID') &&
      user.userId === runtimeValue('OWNER_ACCOUNT_USER_ID')) ||
    (user.provider === 'supabase' &&
      user.emailConfirmed &&
      !!runtimeValue('ZENTRA_OWNER_EMAIL') &&
      user.email.toLowerCase() ===
        runtimeValue('ZENTRA_OWNER_EMAIL').toLowerCase())
  );
}
async function signedIn() {
  const user = await getZentraUser();
  if (!user)
    throw new SupportError(
      'Connectez-vous à Zentra pour ouvrir votre espace support.',
      401,
    );
  await rememberSupportOwner(user);
  await attachSupportAccess(user);
  return user;
}
async function workspaces(user: ZentraUser) {
  return (
    await database()
      .prepare(
        `SELECT w.*,CASE WHEN w.owner_id=? THEN 'owner' ELSE m.role END AS role FROM support_workspaces w LEFT JOIN support_members m ON m.workspace_id=w.id AND m.email=? WHERE w.owner_id=? OR m.id IS NOT NULL ORDER BY w.created_at,w.id`,
      )
      .bind(user.userId, user.email.toLowerCase(), user.userId)
      .all<Workspace & { role: string }>()
  ).results;
}
async function access(user: ZentraUser, workspaceId: string, manage = false) {
  const workspace = (await workspaces(user)).find((w) => w.id === workspaceId);
  if (!workspace)
    throw new SupportError(
      'Cet espace support n’est pas accessible avec votre compte.',
      404,
    );
  if (manage && !['owner', 'admin'].includes(workspace.role))
    throw new SupportError(
      'Seul un administrateur peut modifier la configuration.',
      403,
    );
  return workspace;
}
async function event(
  workspaceId: string,
  ticketId: string | null,
  kind: string,
  detail: string,
  actor: string,
) {
  await database()
    .prepare(
      'INSERT INTO support_events(id,workspace_id,ticket_id,kind,detail,actor,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .bind(
      crypto.randomUUID(),
      workspaceId,
      ticketId,
      kind,
      detail.slice(0, 700),
      actor,
      now(),
    )
    .run();
}
async function connectionFor(workspaceId: string, id: string) {
  const c = await database()
    .prepare(
      'SELECT * FROM support_connections WHERE workspace_id=? AND id=? AND active=1',
    )
    .bind(workspaceId, id)
    .first<Connection>();
  if (!c)
    throw new SupportError(
      'Cette connexion n’est plus active. Reconnectez votre outil.',
      404,
    );
  return mailConnection(c);
}
async function secretFor(connection: Connection) {
  if (connection.provider === 'zendesk' && connection.login === 'oauth:zendesk')
    return zendeskSecret(connection);
  return connection.provider === 'api'
    ? ''
    : decryptSecret(
        runtimeValue('SUPPORT_ENCRYPTION_KEY'),
        connection.secret,
        `connection:${connection.workspace_id}:${connection.id}`,
      );
}
async function aiKey() {
  const row = await database()
    .prepare("SELECT secret FROM support_platform_secrets WHERE id='typesafe'")
    .first<{ secret: string }>();
  return row
    ? decryptSecret(
        runtimeValue('SUPPORT_ENCRYPTION_KEY'),
        row.secret,
        'platform:typesafe',
      )
    : runtimeValue('TYPESAFE_API_KEY');
}
async function platformAccess(request?: Request) {
  if (request && (await hasAdminSession(request))) return 'support-admin-token';
  const user = await signedIn();
  if (!platformOwner(user))
    throw new SupportError(
      'Cet espace est réservé au propriétaire de Zentra.',
      403,
    );
  return user.userId;
}
export async function getPlatformState(request?: Request) {
  await platformAccess(request);
  const row = await database()
    .prepare(
      "SELECT updated_at FROM support_platform_secrets WHERE id='typesafe'",
    )
    .first<{ updated_at: number }>();
  const key = await aiKey();
  const savedReport = await database()
    .prepare(
      "SELECT secret FROM support_platform_secrets WHERE id='triage-evaluation'",
    )
    .first<{ secret: string }>();
  let calibration: CalibrationReport | null = null;
  if (savedReport && key) {
    try {
      const saved = JSON.parse(
        await decryptSecret(
          runtimeValue('SUPPORT_ENCRYPTION_KEY'),
          savedReport.secret,
          'platform:triage-evaluation',
        ),
      );
      if (
        saved.keyBinding === (await digest(key)) &&
        saved.report?.policyVersion === TRIAGE_POLICY_VERSION
      )
        calibration = saved.report;
    } catch {
      /* A stale diagnostic never prevents updating the provider key. */
    }
  }
  return supportJson({
    ready: !!key,
    verifiedAt: row?.updated_at ?? null,
    calibration,
    billing: await supportBillingAdminState(),
    zendesk: await zendeskAvailability(true),
  });
}
function destination(
  value: unknown,
  directory: Directory,
  provider: Provider,
): Destination {
  const row = record(value),
    teamId = text(row.teamId, 100),
    agentId = text(row.agentId, 100);
  if (!directory.teams.some((t) => t.id === teamId))
    throw new SupportError(
      'Choisissez une équipe disponible dans votre outil.',
    );
  if (agentId && !directory.agents.some((a) => a.id === agentId))
    throw new SupportError(
      'Choisissez un agent disponible ou laissez l’équipe répartir le ticket.',
    );
  return { teamId, ...(agentId ? { agentId } : {}) };
}
function publicConnection(c: Connection) {
  c = mailConnection(c);
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    domain: c.domain,
    directory: JSON.parse(c.directory_json) as Directory,
    rules: JSON.parse(c.routes_json) as Rules,
    active: !!c.active,
    hookUrl: `${publicSiteUrl()}/api/support/hooks/${c.id}`,
  };
}
function publicTicket(t: Ticket) {
  return {
    id: t.id,
    connectionId: t.connection_id,
    externalId: t.external_id,
    subject: t.subject,
    body: t.body,
    revision: t.revision,
    state: t.state,
    decision: t.decision_json
      ? {
          ...(JSON.parse(t.decision_json) as Decision),
          model: 'Zentra Support',
        }
      : null,
    error: t.error,
    automatic: !!t.automatic,
    corrected: !!t.corrected,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    routedAt: t.routed_at,
  };
}

export async function getWorkspaceState(request: Request) {
  const user = await signedIn(),
    list = await workspaces(user),
    params = new URL(request.url).searchParams;
  const workspace = params.get('workspace')
    ? list.find((w) => w.id === params.get('workspace'))
    : list[0];
  if (params.get('workspace') && !workspace)
    throw new SupportError('Cet espace support n’est pas accessible.', 404);
  const basic = {
    user: { name: user.displayName, email: user.email },
    platformOwner: platformOwner(user),
    workspaces: list.map((w) => ({ id: w.id, name: w.name, role: w.role })),
  };
  if (!workspace) return supportJson({ ...basic, workspace: null });
  const connections = await database()
    .prepare(
      'SELECT * FROM support_connections WHERE workspace_id=? AND active=1 ORDER BY created_at',
    )
    .bind(workspace.id)
    .all<Connection>();
  const search = text(params.get('search'), 160),
    state = text(params.get('state'), 25);
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`,
    before = Number(params.get('before') || 0),
    beforeId = text(params.get('beforeId'), 50);
  if (!Number.isSafeInteger(before) || before < 0)
    throw new SupportError('La pagination a expiré. Rechargez les tickets.');
  const query = `SELECT * FROM support_tickets WHERE workspace_id=? AND (?='' OR subject LIKE ? ESCAPE '\\' OR external_id LIKE ? ESCAPE '\\') AND (?='' OR state=?) AND (?=0 OR updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT 61`;
  const tickets = await database()
    .prepare(query)
    .bind(
      workspace.id,
      search,
      pattern,
      pattern,
      state,
      state,
      before,
      before,
      before,
      beforeId,
    )
    .all<Ticket>();
  const counts = await database()
    .prepare(
      `SELECT COUNT(*) AS total,SUM(state='review') AS review,SUM(state='error') AS errors,SUM(state='ready') AS ready,SUM(state='routed') AS routed,SUM(state='routed' AND automatic=1 AND corrected=0) AS automatic,SUM(corrected=1) AS corrections FROM support_tickets WHERE workspace_id=? AND created_at>=?`,
    )
    .bind(workspace.id, now() - 30 * 86400)
    .first<Record<string, number>>();
  const manage = ['owner', 'admin'].includes(workspace.role);
  const members = manage
    ? (
        await database()
          .prepare(
            'SELECT id,email,role FROM support_members WHERE workspace_id=? ORDER BY created_at',
          )
          .bind(workspace.id)
          .all()
      ).results
    : [];
  const billing = await billingState(workspace);
  const events = await database()
    .prepare(
      'SELECT id,ticket_id AS ticketId,kind,detail,actor,created_at AS createdAt FROM support_events WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 80',
    )
    .bind(workspace.id)
    .all();
  return supportJson({
    ...basic,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      mode: workspace.mode,
      threshold: workspace.threshold,
      baselineSeconds: workspace.baseline_seconds,
      triageContext: workspace.triage_context || '',
      role: workspace.role,
      canManage: manage,
      aiReady: !!(await aiKey()),
    },
    connections: connections.results.map(publicConnection),
    mailboxes: await mailboxStates(workspace.id),
    gestion: await gestionLinkState(workspace.id,user.userId,manage),
    mailSync: {
      background: runtimeValue('SUPPORT_MAIL_BACKGROUND_ENABLED') === '1',
    },
    zendesk: await zendeskAvailability(),
    tickets: billing.active
      ? tickets.results.slice(0, 60).map(publicTicket)
      : [],
    hasMore: billing.active && tickets.results.length > 60,
    counts: billing.active
      ? counts
      : {
          total: 0,
          review: 0,
          errors: 0,
          ready: 0,
          routed: 0,
          automatic: 0,
          corrections: 0,
        },
    members,
    billing,
    events: billing.active ? events.results : [],
  });
}

export async function mutateWorkspace(request: Request) {
  requireSameOrigin(request);
  const body = await readJsonObjectWithinLimit(request, 64000),
    action = text(body.action, 40),
    db = database();
  if (action === 'configureZendesk') {
    const actor = await platformAccess(request);
    await enforceAccountRateLimit(request, 'support-admin-oauth', actor, 10);
    return supportJson(await configureZendesk(body, actor));
  }
  if (action === 'verifyBilling') {
    const actor = await platformAccess(request);
    await enforceAccountRateLimit(
      request,
      'support-admin-billing-probe',
      actor,
      3,
    );
    return supportJson(await verifySupportBilling());
  }
  if (action === 'configureBilling') {
    const actor = await platformAccess(request);
    await enforceAccountRateLimit(request, 'support-admin-billing', actor, 6);
    return supportJson(await provisionSupportBilling());
  }
  if (action === 'validateTriage') {
    const actor = await platformAccess(request);
    await enforceAccountRateLimit(
      request,
      'support-admin-evaluation',
      actor,
      4,
    );
    const key = await aiKey(),
      report = await evaluateCalibration(key);
    const sealed = await encryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      JSON.stringify({ keyBinding: await digest(key), report }),
      'platform:triage-evaluation',
    );
    await db
      .prepare(
        "INSERT INTO support_platform_secrets(id,secret,updated_by,updated_at) VALUES('triage-evaluation',?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      )
      .bind(sealed, actor, now())
      .run();
    return supportJson({ report });
  }
  if (action === 'evaluateTestBatch') {
    const actor = await platformAccess(request);
    const tickets = evaluationTickets(body.tickets);
    await enforceAccountRateLimit(
      request,
      'support-admin-test-batch',
      actor,
      300,
    );
    return supportJson(await evaluateTestBatch(await aiKey(), tickets));
  }
  if (action === 'evaluateDocumentBatch') {
    const actor = await platformAccess(request);
    const documents = evaluationDocuments(body.tickets);
    await enforceAccountRateLimit(request, 'support-admin-test-batch', actor, 300);
    return supportJson(await evaluateDocumentBatch(await aiKey(), documents));
  }
  if (action === 'platformKey') {
    const actor = await platformAccess(request);
    await enforceAccountRateLimit(request, 'support-admin-key', actor, 15);
    const key = await verifyPlatformApiKey(body.apiKey);
    const sealed = await encryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      key,
      'platform:typesafe',
    );
    await db
      .prepare(
        "INSERT INTO support_platform_secrets(id,secret,updated_by,updated_at) VALUES('typesafe',?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      )
      .bind(sealed, actor, now())
      .run();
    return supportJson({ saved: true });
  }
  const user = await signedIn();
  await enforceAccountRateLimit(request, 'support-ui', user.userId, 180);
  if (action === 'createWorkspace') {
    const name = text(body.name, 100);
    if (name.length < 2)
      throw new SupportError(
        'Indiquez le nom de votre entreprise ou de votre équipe.',
      );
    const existing = await db
      .prepare('SELECT id FROM support_workspaces WHERE owner_id=?')
      .bind(user.userId)
      .first<{ id: string }>();
    if (existing) return supportJson({ workspaceId: existing.id });
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES(?,?,?,'automatic',?,?)",
      )
      .bind(id, user.userId, name, now(), now())
      .run();
    await event(id, null, 'workspace', 'Espace support créé.', user.email);
    return supportJson({ workspaceId: id }, 201);
  }
  const workspace = await access(
    user,
    text(body.workspaceId, 50),
    [
      'settings',
      'connect',
      'connectMailbox',
      'linkGestion',
      'syncMailbox',
      'syncMailboxes',
      'startZendesk',
      'disconnect',
      'refreshDirectory',
      'routes',
      'rotateHook',
      'invite',
      'revokeMember',
    ].includes(action),
  );
  if (
    ['checkout', 'billingPortal', 'refreshPayment', 'cancelCheckout'].includes(
      action,
    )
  ) {
    await enforceAccountRateLimit(request, 'support-billing', user.userId, 30);
    if (action === 'checkout')
      return supportJson(await createSupportCheckout(workspace, user, body));
    if (action === 'cancelCheckout')
      return supportJson(await cancelSupportCheckout(workspace, user));
    if (action === 'billingPortal')
      return supportJson(await createSupportPortal(workspace, user));
    return supportJson(
      await refreshSupportPayment(
        workspace,
        user,
        text(body.sessionId, 200) || undefined,
      ),
    );
  }
  if (['importTicket', 'retry', 'approve', 'invite'].includes(action))
    await requireSupportSubscription(workspace);
  if (action === 'settings') {
    const name = text(body.name, 100),
      threshold = Number(body.threshold),
      baseline = Number(body.baselineSeconds),
      triageContext =
        body.triageContext === undefined
          ? workspace.triage_context || ''
          : text(body.triageContext, 2001);
    if (
      name.length < 2 ||
      !['automatic', 'review'].includes(String(body.mode)) ||
      !Number.isInteger(threshold) ||
      threshold < 50 ||
      threshold > 100 ||
      !Number.isInteger(baseline) ||
      baseline < 5 ||
      baseline > 900 ||
      triageContext.length > 2000
    )
      throw new SupportError(
        'Vérifiez le nom, le seuil (50 à 100 %) et le temps de tri (5 à 900 secondes).',
      );
    if (body.mode === 'automatic' && !(await aiKey()))
      throw new SupportError(
        'Le tri automatique est en cours d’activation par Zentra. Vous pouvez déjà connecter votre outil.',
      );
    await db
      .prepare(
        'UPDATE support_workspaces SET name=?,mode=?,threshold=?,baseline_seconds=?,triage_context=?,updated_at=? WHERE id=?',
      )
      .bind(
        name,
        body.mode,
        threshold,
        baseline,
        triageContext,
        now(),
        workspace.id,
      )
      .run();
    await event(
      workspace.id,
      null,
      'settings',
      `Mode : ${body.mode}. Seuil : ${threshold} %.`,
      user.email,
    );
    return supportJson({ saved: true });
  }
  if (action === 'aiKey')
    throw new SupportError(
      'L’analyse est fournie par Zentra. Aucune clé IA client n’est nécessaire.',
      403,
    );
  if (action === 'invite' || action === 'revokeMember') {
    if (workspace.role !== 'owner')
      throw new SupportError(
        'Seul le titulaire de l’espace peut gérer les accès.',
        403,
      );
    if (action === 'revokeMember')
      await db
        .prepare('DELETE FROM support_members WHERE workspace_id=? AND id=?')
        .bind(workspace.id, text(body.memberId, 50))
        .run();
    else {
      const email = normalizedEmail(String(body.email ?? ''));
      if (email === user.email.toLowerCase())
        throw new SupportError('Vous êtes déjà titulaire de cet espace.');
      const role = text(body.role);
      if (!['admin', 'member', 'read_only'].includes(role))
        throw new SupportError('Choisissez un rôle valide.');
      await db
        .prepare(
          'INSERT INTO support_members(id,workspace_id,email,role,created_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,email) DO UPDATE SET role=excluded.role',
        )
        .bind(crypto.randomUUID(), workspace.id, email, role, now())
        .run();
    }
    await event(
      workspace.id,
      null,
      'members',
      action === 'invite'
        ? 'Accès collaborateur ajouté ou modifié.'
        : 'Accès collaborateur retiré.',
      user.email,
    );
    return supportJson({
      saved: true,
      inviteUrl: `${publicSiteUrl()}/support/espace?workspace=${workspace.id}`,
    });
  }
  if (action === 'startZendesk')
    return supportJson(
      await startZendesk(workspace.id, user.userId, body, platformOwner(user)),
    );
  if (action === 'connectMailbox') {
    if (body.authMode != null && body.authMode !== 'imap' && body.authMode !== 'api') throw new SupportError('Mode de connexion invalide.', 422);
    await enforceAccountRateLimit(
      request,
      'support-mail-connect',
      user.userId,
      10,
    );
    return supportJson(
      await connectMailbox(
        workspace,
        text(body.email, 254),
        body.authMode === 'imap' ? (typeof body.password === 'string' ? body.password : '') : text(body.apiKey, 8192),
        body.authMode === 'imap' ? 'imap' : 'api',
      ),
      201,
    );
  }
  if(action==='linkGestion') {
    await requireSupportSubscription(workspace);
    return supportJson(await saveGestionLink(workspace,user.userId,body));
  }
  if (action === 'syncMailboxes') {
    await enforceAccountRateLimit(
      request,
      'support-mail-poll',
      user.userId,
      120,
    );
    const c = await db
      .prepare(
        "SELECT c.* FROM support_connections c JOIN support_mailboxes m ON m.connection_id=c.id WHERE c.workspace_id=? AND c.active=1 AND c.provider='infomaniak' AND m.next_sync_at<=? AND m.lease_until<=? ORDER BY m.next_sync_at,m.connection_id LIMIT 1",
      )
      .bind(workspace.id, now(), now())
      .first<Connection>();
    return supportJson(c ? await syncMailbox(workspace, c) : { idle: true });
  }
  if (action === 'syncMailbox') {
    await enforceAccountRateLimit(
      request,
      'support-mail-sync',
      user.userId,
      20,
    );
    const c = await connectionFor(workspace.id, text(body.connectionId, 50));
    return supportJson(await syncMailbox(workspace, c));
  }
  if (action === 'connect') {
    const provider = text(body.provider) as Provider;
    if (!['zendesk', 'freshdesk', 'gorgias', 'api'].includes(provider))
      throw new SupportError('Choisissez un outil de support.');
    if (provider === 'zendesk' || provider === 'gorgias')
      throw new SupportError(
        'Utilisez l’autorisation officielle du logiciel. Les clés personnelles ne sont pas acceptées pour cette connexion.',
        400,
      );
    const domain = providerDomain(provider, text(body.domain, 500)),
      login = text(body.login, 254),
      key = text(body.apiKey, 8192),
      label = text(body.label, 100) || domain || 'API personnalisée';
    if (
      provider !== 'api' &&
      (!key ||
        (provider !== 'freshdesk' &&
          !/^[^\s:@]+@[^\s:]+\.[^\s:]+$/.test(login)))
    )
      throw new SupportError(
        'Renseignez la clé API et l’adresse du compte qui possède cette clé.',
      );
    const duplicate = await db
      .prepare(
        'SELECT id FROM support_connections WHERE workspace_id=? AND provider=? AND domain=? AND active=1',
      )
      .bind(workspace.id, provider, domain)
      .first();
    if (duplicate)
      throw new SupportError(
        'Ce compte est déjà connecté. Vous pouvez le déconnecter puis le reconnecter pour changer sa clé.',
      );
    const directory = await loadDirectory({ provider, domain, login }, key);
    if (!directory.teams.length)
      throw new SupportError(
        'Créez au moins une équipe dans votre outil avant de le connecter.',
      );
    const id = crypto.randomUUID(),
      token = newHookToken(),
      sealed =
        provider === 'api'
          ? ''
          : await encryptSecret(
              runtimeValue('SUPPORT_ENCRYPTION_KEY'),
              key,
              `connection:${workspace.id}:${id}`,
            );
    await db
      .prepare(
        'INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        workspace.id,
        provider,
        label,
        domain,
        login,
        sealed,
        await digest(token),
        JSON.stringify(directory),
        '{}',
        now(),
      )
      .run();
    await event(
      workspace.id,
      null,
      'connection',
      `${label} connecté.`,
      user.email,
    );
    return supportJson(
      { saved: true, connectionId: id, hookToken: token },
      201,
    );
  }
  if (
    ['disconnect', 'refreshDirectory', 'routes', 'rotateHook'].includes(action)
  ) {
    const c = await connectionFor(workspace.id, text(body.connectionId, 50));
    if (action === 'disconnect') {
      await db
        .prepare(
          'UPDATE support_connections SET active=0,secret=?,hook_hash=? WHERE workspace_id=? AND id=?',
        )
        .bind('', '', workspace.id, c.id)
        .run();
      await event(
        workspace.id,
        null,
        'connection',
        `${c.label} déconnecté. Les tickets conservés restent consultables.`,
        user.email,
      );
      return supportJson({ saved: true });
    }
    if (action === 'rotateHook') {
      if (c.provider === 'infomaniak')
        throw new SupportError(
          'La boîte mail se synchronise directement, sans webhook.',
        );
      const token = newHookToken();
      await db
        .prepare(
          'UPDATE support_connections SET hook_hash=? WHERE workspace_id=? AND id=?',
        )
        .bind(await digest(token), workspace.id, c.id)
        .run();
      return supportJson({ hookToken: token, connectionId: c.id });
    }
    if (action === 'refreshDirectory') {
      const directory =
        c.provider === 'infomaniak'
          ? MAIL_DIRECTORY
          : await loadDirectory(c, await secretFor(c));
      await db
        .prepare(
          'UPDATE support_connections SET directory_json=? WHERE workspace_id=? AND id=?',
        )
        .bind(JSON.stringify(directory), workspace.id, c.id)
        .run();
      return supportJson({ saved: true });
    }
    let directory = JSON.parse(c.directory_json) as Directory;
    if (c.provider === 'api' && body.teams) {
      if (
        !Array.isArray(body.teams) ||
        body.teams.length < 1 ||
        body.teams.length > 100
      )
        throw new SupportError('Ajoutez entre 1 et 100 équipes.');
      const teams = body.teams.map((v) => ({
        id: externalId(record(v).id),
        name: text(record(v).name, 120),
      }));
      if (
        teams.some((t) => !t.name) ||
        new Set(teams.map((t) => t.id)).size !== teams.length
      )
        throw new SupportError(
          'Chaque équipe doit avoir un nom et un identifiant unique.',
        );
      directory = { teams, agents: [] };
    }
    const rules: Rules = {};
    for (const [category, value] of Object.entries(record(body.rules))) {
      if (!Object.hasOwn(CATEGORIES, category))
        throw new SupportError('Catégorie inconnue.');
      if (value && record(value).teamId)
        rules[category as keyof Rules] = destination(
          value,
          directory,
          c.provider,
        );
    }
    await db
      .prepare(
        'UPDATE support_connections SET routes_json=?,directory_json=? WHERE workspace_id=? AND id=?',
      )
      .bind(
        JSON.stringify(rules),
        JSON.stringify(directory),
        workspace.id,
        c.id,
      )
      .run();
    await event(
      workspace.id,
      null,
      'routing',
      `Règles de ${c.label} mises à jour.`,
      user.email,
    );
    return supportJson({ saved: true });
  }
  if (workspace.role === 'read_only')
    throw new SupportError(
      'Votre accès permet de consulter les tickets, pas de les modifier.',
      403,
    );
  if (action === 'importTicket') {
    const c = await connectionFor(workspace.id, text(body.connectionId, 50));
    if (c.provider === 'api' || c.provider === 'infomaniak')
      throw new SupportError(
        'Utilisez l’API de cette connexion pour transmettre un ticket.',
      );
    const source = await readProviderTicket(
      c,
      await secretFor(c),
      externalId(body.externalId),
    );
    const ticket = await ingest(c, source);
    await processTicket(ticket.id, workspace, c, user.email);
    return supportJson({ ticketId: ticket.id });
  }
  if (action === 'retry' || action === 'approve') {
    const ticket = await db
      .prepare('SELECT * FROM support_tickets WHERE workspace_id=? AND id=?')
      .bind(workspace.id, text(body.ticketId, 50))
      .first<Ticket>();
    if (!ticket) throw new SupportError('Ce ticket n’existe plus.', 404);
    if (ticket.revision !== Number(body.revision))
      throw new SupportError(
        'Ce ticket a changé. Rechargez sa fiche avant de continuer.',
        409,
      );
    const c = await connectionFor(workspace.id, ticket.connection_id);
    if (action === 'retry') {
      if (c.provider !== 'api') {
        const fresh = c.provider === 'infomaniak' ? await refreshMailboxTicket(workspace, c, JSON.parse(ticket.source_json) as SourceTicket) : await readProviderTicket(
          c,
          await secretFor(c),
          ticket.external_id,
        );
        await ingest(c, fresh);
      }
      await processTicket(ticket.id, workspace, c, user.email, undefined, true);
    } else {
      const category = text(body.category) as Decision['category'],
        priority = text(body.priority) as Decision['priority'];
      if (
        !Object.hasOwn(CATEGORIES, category) ||
        !Object.hasOwn(PRIORITIES, priority)
      )
        throw new SupportError('Choisissez une catégorie et une priorité.');
      const dest = destination(
        body.destination,
        JSON.parse(c.directory_json) as Directory,
        c.provider,
      );
      await processTicket(
        ticket.id,
        workspace,
        c,
        user.email,
        {
          category,
          priority,
          destination: dest,
          confidence: 1,
          categoryConfidence: 1,
          priorityConfidence: 1,
          probabilities: {},
          model: 'human',
          inputTokens: 0,
          reason: 'Affectation validée par un membre de votre équipe.',
          manual: true,
        },
        false,
        Number(body.revision),
      );
    }
    return supportJson({ saved: true });
  }
  throw new SupportError('Action inconnue. Rechargez la page.');
}

export async function ingest(connection: Connection, source: SourceTicket) {
  if (!source.body.trim())
    throw new SupportError(
      'Ce ticket ne contient pas encore de texte à analyser.',
    );
  const db = database(),
    hash = await digest(JSON.stringify([source.subject, mailAnalysisBody(source)]));
  await db
    .prepare(
      `INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      connection.workspace_id,
      connection.id,
      source.externalId,
      source.subject,
      source.body,
      JSON.stringify(source),
      hash,
      now(),
      now(),
    )
    .run();
  let existing = await db
    .prepare(
      'SELECT * FROM support_tickets WHERE workspace_id=? AND connection_id=? AND external_id=?',
    )
    .bind(connection.workspace_id, connection.id, source.externalId)
    .first<Ticket>();
  if (!existing)
    throw new SupportError(
      'Le ticket n’a pas pu être enregistré. Réessayez.',
      503,
    );
  if (existing.fingerprint !== hash) {
    if (existing.lease_until && existing.lease_until > now())
      throw new SupportError(
        'Ce ticket est en cours de traitement. Réessayez dans quelques instants.',
        503,
      );
    await db
      .prepare(
        `UPDATE support_tickets SET subject=?,body=?,source_json=?,fingerprint=?,revision=revision+1,state='pending',decision_json=NULL,error=NULL,automatic=0,routed_at=NULL,lease=NULL,lease_until=NULL,attempts=0,updated_at=? WHERE id=? AND workspace_id=? AND revision=? AND (lease_until IS NULL OR lease_until<=?)`,
      )
      .bind(
        source.subject,
        source.body,
        JSON.stringify(source),
        hash,
        now(),
        existing.id,
        connection.workspace_id,
        existing.revision,
        now(),
      )
      .run();
    existing = await db
      .prepare('SELECT * FROM support_tickets WHERE workspace_id=? AND id=?')
      .bind(connection.workspace_id, existing.id)
      .first<Ticket>();
  }
  return existing!;
}

export async function processTicket(
  id: string,
  workspace: Workspace,
  connection: Connection,
  actor: string,
  manual?: Decision,
  retry = false,
  expectedRevision?: number,
) {
  if (workspace.mode === 'paused' && !manual) return;
  await requireSupportSubscription(workspace);
  const db = database(),
    lease = crypto.randomUUID(),
    time = now();
  const ticket = await db
    .prepare(
      `UPDATE support_tickets SET lease=?,lease_until=?,state='processing',attempts=attempts+1 WHERE id=? AND workspace_id=? AND (lease_until IS NULL OR lease_until<=?) AND (?=1 OR state IN ('pending','error','processing')) AND (? IS NULL OR revision=?) RETURNING *`,
    )
    .bind(
      lease,
      time + 180,
      id,
      workspace.id,
      time,
      manual || retry ? 1 : 0,
      expectedRevision ?? null,
      expectedRevision ?? null,
    )
    .first<Ticket>();
  if (!ticket) {
    const current = await db
      .prepare(
        'SELECT state,lease_until FROM support_tickets WHERE id=? AND workspace_id=?',
      )
      .bind(id, workspace.id)
      .first<{ state: string; lease_until: number | null }>();
    if (current?.lease_until && current.lease_until > time)
      throw new SupportError('Ce ticket est déjà en cours de traitement.', 503);
    if (manual)
      throw new SupportError(
        'Ce ticket a changé. Rechargez sa fiche avant de continuer.',
        409,
      );
    return;
  }
  let reservation: string | null = null;
  try {
    const active = await connectionFor(workspace.id, connection.id);
    const currentWorkspace = await db
      .prepare('SELECT * FROM support_workspaces WHERE id=?')
      .bind(workspace.id)
      .first<Workspace>();
    if (!currentWorkspace)
      throw new SupportError('Cet espace n’existe plus.', 404);
    if (currentWorkspace.mode === 'paused' && !manual) {
      await db
        .prepare(
          "UPDATE support_tickets SET state='pending',lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
        )
        .bind(id, lease)
        .run();
      return;
    }
    let source = JSON.parse(ticket.source_json) as SourceTicket;
    if (
      manual &&
      active.provider !== 'api' &&
      active.provider !== 'infomaniak'
    ) {
      const fresh = await readProviderTicket(
        active,
        await secretFor(active),
        source.externalId,
      );
      if (fresh.subject !== source.subject || fresh.body !== source.body)
        throw new SupportError(
          'Le contenu du ticket a changé. Actualisez-le avant de l’affecter.',
          409,
        );
      source = fresh;
    }
    if (!manual)
      reservation = await reserveAnalysis(currentWorkspace, id, lease);
    let decision =
      manual ??
      (await evaluateTicket(
        await aiKey(),
        ticket.subject,
        mailAnalysisBody(source),
        JSON.parse(active.routes_json) as Rules,
        currentWorkspace.threshold,
        undefined,
        currentWorkspace.triage_context || '',
      ));
    await finishAnalysis(reservation, true);
    reservation = null;
    let auto =
      !manual &&
      currentWorkspace.mode === 'automatic' &&
      canAutomaticallyRoute(decision, currentWorkspace.threshold) &&
      !source.closed &&
      !source.agentId &&
      !source.incomplete;
    if (!manual && source.incomplete)
      decision = {
        ...decision,
        reason:
          source.incompleteReason || (source.mail?.attachments.length
            ? 'Une pièce jointe nécessite votre vérification avant le classement.'
            : 'Ce ticket est long ou contient un historique étendu. Consultez-le dans votre outil avant de valider.'),
      };
    else if (!manual && source.closed)
      decision = {
        ...decision,
        reason:
          'Le ticket est fermé dans votre outil. Aucun changement automatique.',
      };
    else if (!manual && source.agentId)
      decision = {
        ...decision,
        reason:
          'Le ticket est déjà attribué à une personne. Vérifiez avant de remplacer son affectation.',
      };
    else if (!manual && currentWorkspace.mode === 'review')
      decision = {
        ...decision,
        reason: 'Le mode validation est actif. Confirmez cette affectation.',
      };
    if (decision.destination)
      destination(
        decision.destination,
        JSON.parse(active.directory_json) as Directory,
        active.provider,
      );
    const shouldRoute = !!manual || auto;
    await db
      .prepare(
        'UPDATE support_tickets SET decision_json=?,error=NULL,updated_at=? WHERE id=? AND workspace_id=? AND lease=?',
      )
      .bind(JSON.stringify(decision), now(), id, workspace.id, lease)
      .run();
    let state = 'review';
    if (shouldRoute && decision.destination) {
      if (active.provider === 'api') state = 'ready';
      else if (active.provider === 'infomaniak') state = 'routed';
      else {
        await assignProviderTicket(
          active,
          await secretFor(active),
          source,
          decision.destination,
          decision.priority,
        );
        state = 'routed';
      }
    }
    const corrected =
      manual && ticket.routed_at !== null ? 1 : ticket.corrected;
    await db
      .prepare(
        'UPDATE support_tickets SET state=?,decision_json=?,source_json=?,revision=revision+1,automatic=?,corrected=?,routed_at=?,error=NULL,lease=NULL,lease_until=NULL,updated_at=? WHERE id=? AND workspace_id=? AND lease=?',
      )
      .bind(
        state,
        JSON.stringify(decision),
        JSON.stringify(source),
        auto ? 1 : 0,
        corrected,
        state === 'routed' ? now() : null,
        now(),
        id,
        workspace.id,
        lease,
      )
      .run();
    await event(
      workspace.id,
      id,
      state,
      state === 'routed'
        ? active.provider === 'infomaniak'
          ? `Mail classé dans Zentra Support · ${CATEGORIES[decision.category]} · priorité ${PRIORITIES[decision.priority]}.`
          : `Affectation confirmée dans ${active.label} · ${CATEGORIES[decision.category]} · priorité ${PRIORITIES[decision.priority]}.`
        : state === 'ready'
          ? 'Décision disponible pour votre connecteur API. Confirmation attendue.'
          : decision.reason,
      manual ? actor : 'Zentra Support',
    );
  } catch (error) {
    await finishAnalysis(reservation, false);
    const message =
      error instanceof SupportError
        ? error.message
        : 'Le traitement a été interrompu. Le ticket est conservé ; réessayez.';
    await db
      .prepare(
        "UPDATE support_tickets SET state='error',error=?,lease=NULL,lease_until=NULL,updated_at=? WHERE id=? AND workspace_id=? AND lease=?",
      )
      .bind(message, now(), id, workspace.id, lease)
      .run();
    await event(workspace.id, id, 'error', message, actor);
    throw error;
  }
}

export async function receiveHook(request: Request, connectionId: string) {
  const db = database(),
    c = await db
      .prepare('SELECT * FROM support_connections WHERE id=? AND active=1')
      .bind(connectionId)
      .first<Connection>();
  const token =
    request.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (
    !c ||
    !/^zsup_[A-Za-z0-9_-]{43}$/.test(token) ||
    !equalHash(await digest(token), c.hook_hash)
  )
    throw new SupportError('Clé de connexion invalide.', 401);
  await enforceAccountRateLimit(request, 'support-hook', c.id, 1200);
  const workspace = await db
    .prepare('SELECT * FROM support_workspaces WHERE id=?')
    .bind(c.workspace_id)
    .first<Workspace>();
  if (!workspace) throw new SupportError('Espace introuvable.', 404);
  await requireSupportSubscription(workspace);
  if (request.method === 'GET') {
    if (c.provider !== 'api')
      throw new SupportError(
        'Cette connexion reçoit des événements POST uniquement.',
        405,
      );
    const rows = await db
      .prepare(
        "SELECT * FROM support_tickets WHERE connection_id=? AND workspace_id=? AND state='ready' ORDER BY updated_at LIMIT 50",
      )
      .bind(c.id, workspace.id)
      .all<Ticket>();
    return supportJson({ decisions: rows.results.map(publicTicket) });
  }
  const body = await readJsonObjectWithinLimit(request, 48000);
  if (body.action === 'acknowledge' && c.provider === 'api') {
    if (body.status !== 'applied')
      throw new SupportError(
        'Confirmez uniquement les affectations réellement appliquées.',
      );
    const result = await db
      .prepare(
        "UPDATE support_tickets SET state='routed',routed_at=?,updated_at=? WHERE id=? AND workspace_id=? AND connection_id=? AND revision=? AND state='ready' RETURNING id",
      )
      .bind(
        now(),
        now(),
        text(body.ticketId, 50),
        workspace.id,
        c.id,
        Number(body.revision),
      )
      .first<{ id: string }>();
    if (!result) {
      const previous = await db
        .prepare(
          "SELECT id FROM support_tickets WHERE id=? AND workspace_id=? AND connection_id=? AND revision=? AND state='routed'",
        )
        .bind(
          text(body.ticketId, 50),
          workspace.id,
          c.id,
          Number(body.revision),
        )
        .first();
      if (previous) return supportJson({ acknowledged: true });
      throw new SupportError(
        'La décision a changé ou n’attend pas de confirmation.',
        409,
      );
    }
    await event(
      workspace.id,
      result.id,
      'routed',
      'Affectation déclarée appliquée par le connecteur API.',
      'Connecteur API',
    );
    return supportJson({ acknowledged: true });
  }
  const external = externalId(
    body.ticketId ?? body.id ?? record(body.ticket).id,
  );
  if (
    c.provider === 'api' &&
    (typeof body.body !== 'string' ||
      body.body.length > 24000 ||
      typeof body.subject !== 'string' ||
      body.subject.length > 300)
  )
    throw new SupportError(
      'Envoyez un objet de 300 caractères maximum et un message de 24 000 caractères maximum.',
    );
  const volume = await db
    .prepare(
      'SELECT COUNT(*) AS count FROM support_tickets WHERE workspace_id=? AND created_at>=?',
    )
    .bind(workspace.id, Math.floor(now() / 86400) * 86400)
    .first<{ count: number }>();
  if (
    (volume?.count ?? 0) >= 1000 &&
    !(await db
      .prepare(
        'SELECT id FROM support_tickets WHERE connection_id=? AND external_id=?',
      )
      .bind(c.id, external)
      .first())
  )
    throw new SupportError(
      'La limite de 1 000 nouveaux tickets par jour est atteinte pour cet espace.',
      429,
    );
  const source: SourceTicket =
    c.provider === 'api'
      ? {
          externalId: external,
          subject: text(body.subject, 300),
          body: text(body.body, 24000),
          version: text(body.version, 100),
          groupId: null,
          agentId: null,
          closed: false,
        }
      : await readProviderTicket(c, await secretFor(c), external);
  const ticket = await ingest(c, source);
  await processTicket(ticket.id, workspace, c, 'Connecteur');
  const updated = await db
    .prepare('SELECT * FROM support_tickets WHERE workspace_id=? AND id=?')
    .bind(workspace.id, ticket.id)
    .first<Ticket>();
  return supportJson(
    { ticket: publicTicket(updated!), retry: updated?.state === 'pending' },
    updated?.state === 'pending' ? 202 : 200,
  );
}

export async function zendeskCallback(request: Request) {
  const user = await signedIn();
  const result = await completeZendesk(request, user.userId, user.email);
  return new Response(null, {
    status: 303,
    headers: {
      ...headers,
      Location: `${publicSiteUrl()}/support/espace?workspace=${encodeURIComponent(result.workspaceId)}&section=connections&zendesk=${result.canceled ? 'annule' : 'connecte'}`,
    },
  });
}
