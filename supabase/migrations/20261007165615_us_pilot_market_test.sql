begin;

-- Isolated US experiment: no existing Swiss table, policy, function or data changes.
create table public.us_pilot_leads (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique,
  first_name text not null check (char_length(btrim(first_name)) between 1 and 80),
  last_name text not null check (char_length(btrim(last_name)) between 1 and 80),
  email text not null check (char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  company text not null check (char_length(btrim(company)) between 1 and 160),
  website text check (website is null or (char_length(website) <= 500 and website ~ '^https?://')),
  industry text not null check (char_length(btrim(industry)) between 1 and 120),
  employee_count text not null check (employee_count in ('1–4', '5–10', '11–30', '31–100', '100+')),
  pain_point text not null check (char_length(btrim(pain_point)) between 1 and 2000),
  current_tools text not null check (char_length(btrim(current_tools)) between 1 and 2000),
  demo_interest boolean not null,
  source text not null default 'us_landing' check (source = 'us_landing'),
  utm_source text check (char_length(utm_source) <= 120),
  utm_medium text check (char_length(utm_medium) <= 120),
  utm_campaign text check (char_length(utm_campaign) <= 120),
  created_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'contacted', 'demo_booked', 'pilot', 'converted', 'rejected'))
);
create index us_pilot_leads_status_created_idx on public.us_pilot_leads (status, created_at desc);

create table public.us_pilot_events (
  id uuid primary key,
  visitor_id uuid,
  event_name text not null check (event_name in ('page_view', 'watch_demo', 'demo_completed', 'pilot_cta_clicked', 'pilot_form_started', 'pilot_form_submitted')),
  page text not null default '/us' check (page = '/us'),
  utm_source text check (char_length(utm_source) <= 120),
  utm_medium text check (char_length(utm_medium) <= 120),
  utm_campaign text check (char_length(utm_campaign) <= 120),
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object' and octet_length(properties::text) <= 512),
  created_at timestamptz not null default now()
);
create index us_pilot_events_name_created_idx on public.us_pilot_events (event_name, created_at desc);
create index us_pilot_events_visitor_idx on public.us_pilot_events (visitor_id, event_name);

create table public.us_pilot_rate_limits (
  rate_key text primary key check (rate_key ~ '^[a-f0-9]{64}$'),
  count integer not null check (count > 0),
  expires_at timestamptz not null
);
create index us_pilot_rate_limits_expiry_idx on public.us_pilot_rate_limits (expires_at);

alter table public.us_pilot_leads enable row level security;
alter table public.us_pilot_events enable row level security;
alter table public.us_pilot_rate_limits enable row level security;
revoke all on public.us_pilot_leads, public.us_pilot_events, public.us_pilot_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.us_pilot_leads, public.us_pilot_events, public.us_pilot_rate_limits to service_role;
-- Public visitors submit through the validated, rate-limited server POST endpoint.
-- No direct anonymous insert policy: that would bypass the anti-spam protections.
create policy us_pilot_leads_server_only on public.us_pilot_leads for all to service_role using (true) with check (true);
create policy us_pilot_events_server_only on public.us_pilot_events for all to service_role using (true) with check (true);
create policy us_pilot_rate_limits_server_only on public.us_pilot_rate_limits for all to service_role using (true) with check (true);

create function public.us_pilot_consume_rate_limit(p_key text, p_maximum integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare current_count integer;
begin
  if p_key !~ '^[a-f0-9]{64}$' or p_maximum not between 1 and 500 then
    raise exception 'Invalid rate limit arguments' using errcode = '22023';
  end if;
  delete from public.us_pilot_rate_limits where expires_at < now();
  insert into public.us_pilot_rate_limits as limits (rate_key, count, expires_at)
    values (p_key, 1, now() + interval '1 hour')
  on conflict (rate_key) do update set count = limits.count + 1
  returning count into current_count;
  return current_count <= p_maximum;
end;
$$;
revoke all on function public.us_pilot_consume_rate_limit(text, integer) from public, anon, authenticated;
grant execute on function public.us_pilot_consume_rate_limit(text, integer) to service_role;

commit;
