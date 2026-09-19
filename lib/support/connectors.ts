import {
  record,
  text,
  numericId,
  SupportError,
  type Connection,
  type Destination,
  type Directory,
  type Priority,
  type Provider,
  type SourceTicket,
} from './types';

export function providerDomain(provider: Provider, input: string) {
  if (provider === 'api') return '';
  const suffix = `${provider}.com`;
  let domain = input.trim().toLowerCase();
  if (domain.startsWith('https://')) {
    const u = new URL(domain);
    if (
      u.pathname !== '/' ||
      u.search ||
      u.hash ||
      u.port ||
      u.username ||
      u.password
    )
      throw new SupportError('Indiquez seulement le domaine de votre outil.');
    domain = u.hostname;
  }
  if (!domain.includes('.')) domain = `${domain}.${suffix}`;
  const subdomain = domain.slice(0, -(suffix.length + 1));
  if (
    !domain.endsWith(`.${suffix}`) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)
  )
    throw new SupportError(
      `Utilisez le domaine de votre compte, par exemple boutique.${suffix}.`,
    );
  return domain;
}
function authorization(provider: Provider, login: string, secret: string) {
  const identity =
    provider === 'freshdesk'
      ? `${secret}:X`
      : provider === 'zendesk'
        ? `${login}/token:${secret}`
        : `${login}:${secret}`;
  return `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(identity)))}`;
}
export async function providerRequest(
  connection: Pick<Connection, 'provider' | 'domain' | 'login'>,
  secret: string,
  path: string,
  method = 'GET',
  payload?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const domain = providerDomain(connection.provider, connection.domain);
  if (
    !domain ||
    !path.startsWith('/api/') ||
    path.includes('://') ||
    path.includes('\\')
  )
    throw new SupportError('Adresse de connexion invalide.');
  let response: Response;
  try {
    response = await fetcher(`https://${domain}${path}`, {
      method,
      // Workerd supports manual redirects; never forward provider credentials.
      redirect: 'manual',
      headers: {
        Authorization: authorization(
          connection.provider,
          connection.login,
          secret,
        ),
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(7000),
    });
  } catch {
    throw new SupportError(
      'Votre outil de support ne répond pas. Le ticket est conservé. Réessayez.',
      503,
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new SupportError(
      'Votre outil redirige cette connexion. Vérifiez son domaine dans Connexions. Aucun identifiant n’a été transmis à la nouvelle adresse.',
      502,
    );
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new SupportError(
        'Votre outil refuse la connexion. Vérifiez la clé et les droits dans Connexions.',
        503,
      );
    if (response.status === 404)
      throw new SupportError(
        'Ce ticket ou cette équipe n’existe plus dans votre outil. Actualisez la connexion.',
        409,
      );
    if (response.status === 409 || response.status === 412)
      throw new SupportError(
        'Le ticket a changé dans votre outil. Actualisez-le avant de l’affecter.',
        409,
      );
    if (response.status === 429)
      throw new SupportError(
        'Votre outil limite momentanément les demandes. Réessayez plus tard.',
        503,
      );
    if (response.status === 400 || response.status === 422)
      throw new SupportError(
        'L’affectation est refusée. Vérifiez l’équipe, l’agent et ses droits dans Routage.',
        409,
      );
    throw new SupportError(
      'Le service de support est indisponible. Le ticket reste à traiter.',
      503,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 1_000_000) {
        await reader.cancel();
        throw new SupportError(
          'La réponse de votre outil est trop volumineuse.',
          502,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return length ? JSON.parse(new TextDecoder().decode(data)) : {};
  } catch {
    throw new SupportError('Votre outil a renvoyé une réponse illisible.', 502);
  }
}
export async function loadDirectory(
  connection: Pick<Connection, 'provider' | 'domain' | 'login'>,
  secret: string,
  fetcher: typeof fetch = fetch,
): Promise<Directory> {
  if (connection.provider === 'api')
    return { teams: [{ id: 'support', name: 'Support' }], agents: [] };
  async function load(kind: 'teams' | 'agents') {
    const rows: Record<string, unknown>[] = [];
    let cursor = '';
    for (let page = 1; page <= 20; page++) {
      const path =
        connection.provider === 'zendesk'
          ? `/api/v2/${kind === 'teams' ? 'groups' : 'users'}.json?per_page=100&page=${page}${kind === 'agents' ? '&role[]=agent&role[]=admin' : ''}`
          : connection.provider === 'freshdesk'
            ? `/api/v2/${kind === 'teams' ? 'groups' : 'agents'}?per_page=100&page=${page}`
            : `/api/${kind === 'teams' ? 'teams' : 'users'}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const raw = await providerRequest(
          connection,
          secret,
          path,
          'GET',
          undefined,
          fetcher,
        ),
        object = record(raw);
      const list =
        connection.provider === 'freshdesk'
          ? raw
          : connection.provider === 'zendesk'
            ? object[kind === 'teams' ? 'groups' : 'users']
            : object.data;
      if (!Array.isArray(list))
        throw new SupportError(
          'Impossible de lire les équipes de votre outil. Vérifiez les droits de la clé.',
          502,
        );
      rows.push(...list.map(record));
      const more =
        connection.provider === 'zendesk'
          ? !!object.next_page
          : connection.provider === 'gorgias'
            ? !!record(object.meta).next_cursor
            : list.length === 100;
      if (!more) return rows;
      cursor = text(record(object.meta).next_cursor, 2000);
    }
    throw new SupportError(
      'Le répertoire dépasse 2 000 entrées. Utilisez une clé limitée aux équipes concernées.',
    );
  }
  const teams = await load('teams'),
    agents = await load('agents');
  return {
    teams: teams
      .filter((x) => !x.deleted)
      .map((x) => ({
        id: numericId(x.id),
        name: text(x.name, 120) || `Équipe ${x.id}`,
      })),
    agents: agents
      .filter((x) => x.active !== false && !x.deleted && !x.suspended)
      .map((x) => ({
        id: numericId(x.id),
        name:
          text(x.name ?? record(x.contact).name ?? x.email, 120) ||
          `Agent ${x.id}`,
      })),
  };
}
function plain(value: unknown) {
  return text(value, 1_000_000)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
function idOrNull(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}
export async function readProviderTicket(
  connection: Connection,
  secret: string,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SourceTicket> {
  numericId(id);
  const path =
    connection.provider === 'zendesk'
      ? `/api/v2/tickets/${id}.json`
      : connection.provider === 'freshdesk'
        ? `/api/v2/tickets/${id}`
        : `/api/tickets/${id}`;
  const raw = record(
    await providerRequest(connection, secret, path, 'GET', undefined, fetcher),
  );
  const ticket = connection.provider === 'zendesk' ? record(raw.ticket) : raw;
  if (String(ticket.id) !== id)
    throw new SupportError(
      'Le ticket demandé ne correspond pas à la réponse de votre outil.',
      502,
    );
  let body = plain(
      ticket.description_text ?? ticket.description ?? ticket.excerpt,
    ),
    incomplete = false;
  if (connection.provider === 'gorgias') {
    const messages = record(
      await providerRequest(
        connection,
        secret,
        `/api/messages?ticket_id=${id}&limit=100&order_by=created_datetime:desc`,
        'GET',
        undefined,
        fetcher,
      ),
    );
    if (!Array.isArray(messages.data))
      throw new SupportError(
        'Impossible de lire le contenu de ce ticket Gorgias.',
        502,
      );
    incomplete = !!record(messages.meta).next_cursor;
    body =
      messages.data
        .map(record)
        .filter((m) => m.from_agent === false)
        .reverse()
        .map((m) => plain(m.body_text ?? m.body_html))
        .filter(Boolean)
        .join('\n\n') || body;
  }
  if (connection.provider === 'zendesk') {
    const comments = record(
      await providerRequest(
        connection,
        secret,
        `/api/v2/tickets/${id}/comments.json?sort_order=desc&per_page=100`,
        'GET',
        undefined,
        fetcher,
      ),
    );
    if (!Array.isArray(comments.comments))
      throw new SupportError(
        'Impossible de lire le contenu de ce ticket Zendesk.',
        502,
      );
    incomplete = !!comments.next_page;
    body =
      comments.comments
        .map(record)
        .filter((m) => String(m.author_id) === String(ticket.requester_id))
        .reverse()
        .map((m) => plain(m.plain_body ?? m.body))
        .filter(Boolean)
        .join('\n\n') || body;
  }
  if (connection.provider === 'freshdesk') {
    const comments = await providerRequest(
      connection,
      secret,
      `/api/v2/tickets/${id}/conversations?per_page=30`,
      'GET',
      undefined,
      fetcher,
    );
    if (!Array.isArray(comments))
      throw new SupportError(
        'Impossible de lire le contenu de ce ticket Freshdesk.',
        502,
      );
    incomplete = comments.length >= 30;
    body = [
      body,
      ...comments
        .map(record)
        .filter((m) => m.incoming === true && m.private !== true)
        .map((m) => plain(m.body_text ?? m.body)),
    ].join('\n\n');
  }
  const priority =
    connection.provider === 'freshdesk'
      ? (
          { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' } as Record<
            number,
            Priority
          >
        )[Number(ticket.priority)]
      : ticket.priority === 'critical'
        ? 'urgent'
        : (ticket.priority as Priority);
  return {
    externalId: id,
    subject: text(ticket.subject, 300) || 'Ticket sans objet',
    body: body.slice(0, 24000),
    incomplete: incomplete || body.length > 24000,
    version: text(ticket.updated_at ?? ticket.updated_datetime, 100),
    groupId: idOrNull(ticket.group_id ?? record(ticket.assignee_team).id),
    agentId: idOrNull(
      ticket.assignee_id ??
        ticket.responder_id ??
        record(ticket.assignee_user).id,
    ),
    priority,
    closed: ['solved', 'closed', 4, 5].includes(
      ticket.status as string | number,
    ),
  };
}
export function assignmentPayload(
  provider: Provider,
  destination: Destination,
  priority: Priority,
  version: string,
) {
  const team = Number(numericId(destination.teamId)),
    agent = destination.agentId ? Number(numericId(destination.agentId)) : null;
  if (provider === 'zendesk')
    return {
      ticket: {
        group_id: team,
        assignee_id: agent,
        priority,
        safe_update: true,
        updated_stamp: version,
      },
    };
  if (provider === 'freshdesk')
    return {
      group_id: team,
      responder_id: agent,
      priority: { low: 1, normal: 2, high: 3, urgent: 4 }[priority],
    };
  if (provider === 'gorgias')
    return {
      assignee_team: { id: team },
      assignee_user: agent ? { id: agent } : null,
      priority: priority === 'urgent' ? 'critical' : priority,
    };
  throw new SupportError('Ce connecteur attend une confirmation via son API.');
}
export async function assignProviderTicket(
  connection: Connection,
  secret: string,
  source: SourceTicket,
  destination: Destination,
  priority: Priority,
  fetcher: typeof fetch = fetch,
) {
  const current = await readProviderTicket(
    connection,
    secret,
    source.externalId,
    fetcher,
  );
  if (current.closed)
    throw new SupportError('Ce ticket est déjà fermé dans votre outil.', 409);
  if (current.subject !== source.subject || current.body !== source.body)
    throw new SupportError(
      'Le contenu du ticket a changé. Actualisez-le avant de l’affecter.',
      409,
    );
  const assigned =
    current.groupId === destination.teamId &&
    current.agentId === (destination.agentId || null);
  if (
    !assigned &&
    (current.groupId !== source.groupId || current.agentId !== source.agentId)
  )
    throw new SupportError(
      'Une autre personne a déjà modifié l’affectation. Actualisez ce ticket.',
      409,
    );
  if (assigned && current.priority === priority) return;
  const path =
    connection.provider === 'zendesk'
      ? `/api/v2/tickets/${source.externalId}.json`
      : connection.provider === 'freshdesk'
        ? `/api/v2/tickets/${source.externalId}`
        : `/api/tickets/${source.externalId}`;
  await providerRequest(
    connection,
    secret,
    path,
    'PUT',
    assignmentPayload(
      connection.provider,
      destination,
      priority,
      current.version,
    ),
    fetcher,
  );
  const verified = await readProviderTicket(
    connection,
    secret,
    source.externalId,
    fetcher,
  );
  if (
    verified.groupId !== destination.teamId ||
    verified.agentId !== (destination.agentId || null) ||
    verified.priority !== priority
  )
    throw new SupportError(
      'L’affectation et sa priorité ne sont pas confirmées par votre outil. Vérifiez ce ticket.',
      503,
    );
}
