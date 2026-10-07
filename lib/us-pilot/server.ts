import {
  readJsonObjectWithinLimit,
  RequestBodyError,
} from '@/lib/request-body';
import { supabaseServerClient } from '@/lib/supabase-server-runtime';
import { SupabaseServerError } from '@/lib/supabase-server';
import {
  attribution,
  eventNames,
  PilotInputError,
  isPilotUuid,
  validateLead,
} from './validation';

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(status === 429 ? { 'Retry-After': '3600' } : {}),
    },
  });
function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  return (
    origin === new URL(request.url).origin &&
    !['cross-site', 'none'].includes(
      request.headers.get('Sec-Fetch-Site') ?? '',
    )
  );
}
async function rateLimit(request: Request, scope: string, maximum: number) {
  // CF overwrites this header at the edge. Never trust X-Forwarded-For.
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`zentra-us-v1:${scope}:${address}`),
  );
  const key = [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return supabaseServerClient().rpc<boolean>('us_pilot_consume_rate_limit', {
    p_key: key,
    p_maximum: maximum,
  });
}
function failure(error: unknown) {
  if (error instanceof PilotInputError)
    return json({ error: error.message, fields: error.fields }, 422);
  if (error instanceof RequestBodyError)
    return json(
      { error: 'Invalid request. Please reopen the form and try again.' },
      error.status,
    );
  // No upstream body, submitted values, keys or database details reach the visitor.
  return json(
    {
      error:
        'We could not save this right now. Please try again shortly. Your application has not been confirmed.',
    },
    503,
  );
}
export async function submitPilotLead(request: Request) {
  if (!sameOrigin(request))
    return json({ error: 'Please apply from the Zentra website.' }, 403);
  try {
    const input = await readJsonObjectWithinLimit(request, 12_000);
    if (
      input.contact_note ||
      typeof input.started_at !== 'number' ||
      Date.now() - input.started_at < 1500 ||
      Date.now() - input.started_at > 86_400_000
    )
      return json({ error: 'Please reopen the form and try again.' }, 400);
    const lead = validateLead(input);
    if (!(await rateLimit(request, 'leads', 5)))
      return json(
        {
          error:
            'Too many applications from this connection. Please try again in an hour.',
        },
        429,
      );
    try {
      await supabaseServerClient().insert('us_pilot_leads', lead, {
        returning: false,
      });
    } catch (error) {
      // A retry of the same submission is safe. Only the opaque submission UUID is unique.
      if (!(error instanceof SupabaseServerError && error.code === '23505'))
        throw error;
    }
    // The conversion event is recorded on the server after persistence, independently
    // of ad blockers. Its ID equals the submission ID, so retries cannot inflate it.
    try {
      if (input.measurement_allowed === false) return json({ ok: true }, 201);
      await supabaseServerClient().insert(
        'us_pilot_events',
        {
          id: lead.submission_id,
          event_name: 'pilot_form_submitted',
          page: '/us',
          visitor_id: isPilotUuid(input.visitor_id) ? input.visitor_id : null,
          ...attribution(input),
          properties: {},
        },
        {
          returning: false,
          prefer: ['resolution=ignore-duplicates'],
          query: { on_conflict: 'id' },
        },
      );
    } catch {
      /* Lead remains successful if optional measurement is unavailable. */
    }
    return json({ ok: true }, 201);
  } catch (error) {
    return failure(error);
  }
}
export async function submitPilotEvent(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'Invalid origin.' }, 403);
  try {
    const input = await readJsonObjectWithinLimit(request, 2500);
    if (
      !eventNames.includes(input.event_name as (typeof eventNames)[number]) ||
      input.event_name === 'pilot_form_submitted' ||
      !isPilotUuid(input.id) ||
      !isPilotUuid(input.visitor_id)
    )
      return json({ error: 'Invalid event.' }, 422);
    if (!(await rateLimit(request, 'events', 240)))
      return json({ error: 'Too many events.' }, 429);
    const raw =
      input.properties && typeof input.properties === 'object'
        ? (input.properties as Record<string, unknown>)
        : {};
    const properties: Record<string, string> = {};
    // Allowlist only: no email, company, free text, full URL, or arbitrary payload.
    for (const key of ['placement', 'workflow', 'mode'])
      if (typeof raw[key] === 'string' && /^[a-z_-]{1,40}$/.test(raw[key]))
        properties[key] = raw[key];
    await supabaseServerClient().insert(
      'us_pilot_events',
      {
        id: input.id,
        visitor_id: input.visitor_id,
        event_name: input.event_name,
        page: '/us',
        ...attribution(input),
        properties,
      },
      {
        returning: false,
        prefer: ['resolution=ignore-duplicates'],
        query: { on_conflict: 'id' },
      },
    );
    return json({ ok: true }, 201);
  } catch (error) {
    return failure(error);
  }
}
