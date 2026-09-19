import { database, runtimeValue } from '@/lib/runtime';
import { encryptSecret, decryptSecret, digest, newHookToken } from './crypto';
import { loadDirectory, providerDomain } from './connectors';
import { SupportError, record, text, type Connection } from './types';

export const ZENDESK_SCOPES =
  'tickets:read tickets:write users:read groups:read';
const now = () => Math.floor(Date.now() / 1000);
const callback = () =>
  runtimeValue('PUBLIC_SITE_URL') + '/api/support/oauth/zendesk';
type Configuration = {
  clientId: string;
  clientSecret: string;
  approved: boolean;
  developerDomain: string;
};
type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
};
async function config(): Promise<Configuration | null> {
  const row = await database()
    .prepare(
      "SELECT secret FROM support_platform_secrets WHERE id='zendesk-oauth'",
    )
    .first<{ secret: string }>();
  return row
    ? JSON.parse(
        await decryptSecret(
          runtimeValue('SUPPORT_ENCRYPTION_KEY'),
          row.secret,
          'platform:zendesk-oauth',
        ),
      )
    : null;
}
export async function zendeskAvailability(admin = false) {
  const c = await config();
  return {
    ready: !!c?.approved,
    ...(admin
      ? {
          configured: !!c,
          developerDomain: c?.developerDomain || '',
          redirectUri: callback(),
          scopes: ZENDESK_SCOPES,
        }
      : {}),
  };
}
export async function configureZendesk(
  body: Record<string, unknown>,
  actor: string,
) {
  const clientId = text(body.clientId, 200),
    clientSecret = text(body.clientSecret, 8192);
  if (
    !/^zdg-[A-Za-z0-9_-]{3,190}$/.test(clientId) ||
    !/^[\x21-\x7e]{12,8192}$/.test(clientSecret)
  )
    throw new SupportError(
      'Indiquez l’identifiant zdg- et le secret du client OAuth créé dans Zendesk.',
    );
  const configuration: Configuration = {
    clientId,
    clientSecret,
    approved: body.approved === true,
    developerDomain: providerDomain('zendesk', text(body.developerDomain, 200)),
  };
  const sealed = await encryptSecret(
    runtimeValue('SUPPORT_ENCRYPTION_KEY'),
    JSON.stringify(configuration),
    'platform:zendesk-oauth',
  );
  await database()
    .prepare(
      "INSERT INTO support_platform_secrets(id,secret,updated_by,updated_at) VALUES('zendesk-oauth',?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
    )
    .bind(sealed, actor, now())
    .run();
  return { saved: true, ready: configuration.approved };
}
export async function startZendesk(
  workspaceId: string,
  userId: string,
  input: Record<string, unknown>,
  owner = false,
) {
  const c = await config(),
    domain = providerDomain('zendesk', text(input.domain, 500));
  if (!c || (!c.approved && !(owner && domain === c.developerDomain)))
    throw new SupportError(
      'La connexion Zendesk attend la validation de Zentra par Zendesk. Ne souscrivez pas pour cette connexion tant qu’elle n’est pas disponible.',
      503,
    );
  const state = newHookToken(),
    hash = await digest(state),
    verifier = newHookToken() + newHookToken();
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  await database()
    .prepare('DELETE FROM support_oauth_states WHERE expires_at<=?')
    .bind(now())
    .run();
  await database()
    .prepare(
      'INSERT INTO support_oauth_states(state_hash,user_id,workspace_id,domain,label,verifier,expires_at) VALUES(?,?,?,?,?,?,?)',
    )
    .bind(
      hash,
      userId,
      workspaceId,
      domain,
      text(input.label, 100) || domain,
      await encryptSecret(
        runtimeValue('SUPPORT_ENCRYPTION_KEY'),
        verifier,
        `oauth-state:${hash}`,
      ),
      now() + 600,
    )
    .run();
  const url = new URL(`https://${domain}/oauth/authorizations/new`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: callback(),
    scope: ZENDESK_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString() };
}
async function tokenRequest(
  domain: string,
  body: Record<string, unknown>,
): Promise<Tokens> {
  const c = await config();
  if (!c)
    throw new SupportError(
      'La connexion Zendesk doit être configurée par Zentra.',
      503,
    );
  let response: Response;
  try {
    response = await fetch(
      `https://${providerDomain('zendesk', domain)}/oauth/tokens`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          scope: ZENDESK_SCOPES,
          expires_in: 86400,
          refresh_token_expires_in: 7776000,
          ...body,
        }),
        signal: AbortSignal.timeout(12000),
      },
    );
  } catch {
    throw new SupportError(
      'Zendesk ne répond pas. Réessayez la connexion.',
      503,
    );
  }
  if (!response.ok)
    throw new SupportError(
      'Zendesk a refusé l’autorisation. Reconnectez votre outil ; vérifiez les droits du compte et les autorisations de l’application Zentra.',
      503,
    );
  const raw = await response.text();
  if (raw.length > 40000)
    throw new SupportError('Réponse Zendesk invalide.', 502);
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(raw));
  } catch {
    throw new SupportError('Réponse Zendesk illisible.', 502);
  }
  if (
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    !/^[\x21-\x7e]{12,8192}$/.test(data.access_token) ||
    !/^[\x21-\x7e]{12,8192}$/.test(data.refresh_token) ||
    !Number.isInteger(data.expires_in) ||
    Number(data.expires_in) < 300 ||
    Number(data.expires_in) > 172800 ||
    !Number.isInteger(data.refresh_token_expires_in) ||
    Number(data.refresh_token_expires_in) < 604800 ||
    Number(data.refresh_token_expires_in) > 7776000 ||
    String(data.token_type).toLowerCase() !== 'bearer'
  )
    throw new SupportError(
      'Zendesk n’a pas fourni une autorisation renouvelable. Reconnectez votre outil.',
      502,
    );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now() + Number(data.expires_in),
    refreshExpiresAt: now() + Number(data.refresh_token_expires_in),
  };
}
export async function completeZendesk(
  request: Request,
  userId: string,
  email: string,
) {
  const params = new URL(request.url).searchParams,
    rawState = params.get('state') || '';
  if (!/^zsup_[A-Za-z0-9_-]{43}$/.test(rawState))
    throw new SupportError(
      'Cette autorisation a expiré. Recommencez depuis Connexions.',
      400,
    );
  const hash = await digest(rawState),
    db = database();
  const attempt = await db
    .prepare(
      `SELECT s.* FROM support_oauth_states s JOIN support_workspaces w ON w.id=s.workspace_id WHERE s.state_hash=? AND s.user_id=? AND s.expires_at>? AND (w.owner_id=? OR EXISTS(SELECT 1 FROM support_members m WHERE m.workspace_id=w.id AND m.role='admin' AND m.email=?))`,
    )
    .bind(hash, userId, now(), userId, email.toLowerCase())
    .first<{
      domain: string;
      label: string;
      workspace_id: string;
      verifier: string;
    }>();
  if (!attempt)
    throw new SupportError(
      'Cette autorisation a expiré ou appartient à un autre compte. Recommencez depuis Connexions.',
      403,
    );
  const consumed = await db
    .prepare(
      'DELETE FROM support_oauth_states WHERE state_hash=? AND user_id=?',
    )
    .bind(hash, userId)
    .run();
  if (!consumed.meta.changes)
    throw new SupportError('Cette autorisation a déjà été utilisée.', 409);
  if (params.has('error'))
    return { workspaceId: attempt.workspace_id, canceled: true };
  const code = params.get('code') || '';
  if (!code || code.length > 4000)
    throw new SupportError(
      'Autorisation Zendesk incomplète. Recommencez.',
      400,
    );
  const tokens = await tokenRequest(attempt.domain, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: callback(),
    code_verifier: await decryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      attempt.verifier,
      `oauth-state:${hash}`,
    ),
  });
  const directory = await loadDirectory(
    { provider: 'zendesk', domain: attempt.domain, login: 'oauth:zendesk' },
    tokens.accessToken,
  );
  if (!directory.teams.length)
    throw new SupportError(
      'Ajoutez une équipe dans Zendesk avant de connecter votre outil.',
    );
  const existing = await db
    .prepare(
      "SELECT id FROM support_connections WHERE workspace_id=? AND provider='zendesk' AND domain=? AND active=1",
    )
    .bind(attempt.workspace_id, attempt.domain)
    .first<{ id: string }>();
  const id = existing?.id || crypto.randomUUID(),
    sealed = await encryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      JSON.stringify(tokens),
      `connection:${attempt.workspace_id}:${id}`,
    );
  if (existing)
    await db
      .prepare(
        "UPDATE support_connections SET login='oauth:zendesk',secret=?,directory_json=?,refresh_lease=NULL,refresh_lease_until=0 WHERE id=? AND workspace_id=? AND active=1",
      )
      .bind(sealed, JSON.stringify(directory), id, attempt.workspace_id)
      .run();
  else
    await db
      .prepare(
        "INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,'zendesk',?,?,'oauth:zendesk',?,?,?,'{}',?)",
      )
      .bind(
        id,
        attempt.workspace_id,
        attempt.label,
        attempt.domain,
        sealed,
        await digest(newHookToken()),
        JSON.stringify(directory),
        now(),
      )
      .run();
  return {
    workspaceId: attempt.workspace_id,
    connectionId: id,
    canceled: false,
  };
}
export async function zendeskSecret(connection: Connection) {
  const db = database(),
    context = `connection:${connection.workspace_id}:${connection.id}`;
  // Read fresh tokens for every operation; workers may have rotated them since the ticket was loaded.
  const row = await db
    .prepare(
      'SELECT secret FROM support_connections WHERE id=? AND workspace_id=? AND active=1',
    )
    .bind(connection.id, connection.workspace_id)
    .first<{ secret: string }>();
  if (!row) throw new SupportError('Reconnectez Zendesk dans Connexions.', 503);
  const token = JSON.parse(
    await decryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      row.secret,
      context,
    ),
  ) as Tokens;
  if (token.expiresAt > now() + 90) return token.accessToken;
  if (token.refreshExpiresAt <= now())
    throw new SupportError(
      'L’autorisation Zendesk a expiré. Reconnectez Zendesk dans Connexions.',
      503,
    );
  const lease = crypto.randomUUID(),
    claim = await db
      .prepare(
        'UPDATE support_connections SET refresh_lease=?,refresh_lease_until=? WHERE id=? AND active=1 AND secret=? AND refresh_lease_until<=?',
      )
      .bind(lease, now() + 30, connection.id, row.secret, now())
      .run();
  if (!claim.meta.changes)
    throw new SupportError(
      'Zendesk renouvelle la connexion. Réessayez dans quelques secondes.',
      503,
    );
  try {
    const next = await tokenRequest(connection.domain, {
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
    });
    const sealed = await encryptSecret(
      runtimeValue('SUPPORT_ENCRYPTION_KEY'),
      JSON.stringify(next),
      context,
    );
    const saved = await db
      .prepare(
        'UPDATE support_connections SET secret=?,refresh_lease=NULL,refresh_lease_until=0 WHERE id=? AND active=1 AND refresh_lease=?',
      )
      .bind(sealed, connection.id, lease)
      .run();
    if (!saved.meta.changes)
      throw new SupportError(
        'Cette connexion a changé. Reconnectez Zendesk.',
        409,
      );
    return next.accessToken;
  } finally {
    await db
      .prepare(
        'UPDATE support_connections SET refresh_lease=NULL,refresh_lease_until=0 WHERE id=? AND refresh_lease=?',
      )
      .bind(connection.id, lease)
      .run();
  }
}
