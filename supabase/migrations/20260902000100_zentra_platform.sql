begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

create schema if not exists private;
create schema if not exists migration;

revoke all on schema private from public, anon, authenticated;
revoke all on schema migration from public, anon, authenticated;
grant usage on schema private to authenticated;

create type public.organization_role as enum (
  'owner',
  'admin',
  'accountant',
  'member',
  'read_only'
);

create type public.device_authorization_status as enum (
  'pending',
  'approved',
  'exchanging',
  'consumed',
  'revoked'
);

create type public.invoice_archive_kind as enum ('initial', 'correction');
create type public.invoice_archive_status as enum ('pending', 'stored');
create type public.domain_verification_status as enum (
  'pending',
  'verified',
  'active',
  'failed',
  'revoked'
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on update cascade on delete cascade,
  email extensions.citext,
  email_confirmed_at timestamptz,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_email_length check (
    email is null or char_length(email::text) between 3 and 254
  ),
  constraint profiles_display_name_length check (
    display_name is null or char_length(display_name) between 1 and 160
  )
);

create unique index profiles_email_unique_idx on public.profiles (email);

create table public.subscriptions (
  subscription_id text primary key,
  customer_id text not null,
  checkout_session_id text unique,
  customer_email extensions.citext,
  customer_name text,
  price_id text not null,
  status text not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  livemode boolean not null default false,
  entitlement_valid_until timestamptz,
  last_paid_invoice_id text,
  last_paid_at timestamptz,
  last_payment_failure_invoice_id text,
  last_payment_failure_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint subscriptions_subscription_id_format check (subscription_id ~ '^sub_[A-Za-z0-9_]+$'),
  constraint subscriptions_customer_id_format check (customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  constraint subscriptions_price_id_format check (price_id ~ '^price_[A-Za-z0-9_]+$'),
  constraint subscriptions_customer_name_length check (
    customer_name is null or char_length(customer_name) <= 160
  )
);

create index subscriptions_customer_idx on public.subscriptions (customer_id);
create index subscriptions_entitlement_idx
  on public.subscriptions (status, entitlement_valid_until);

create table public.organizations (
  organization_id text primary key default ('org_' || gen_random_uuid()::text),
  name text not null,
  subscription_id text unique references public.subscriptions(subscription_id)
    on update cascade on delete restrict,
  created_by_user_id uuid not null references auth.users(id)
    on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_id_format check (
    organization_id ~ '^org_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint organizations_name_length check (char_length(btrim(name)) between 1 and 160)
);

create index organizations_creator_idx on public.organizations (created_by_user_id);

create table public.organization_members (
  membership_id text primary key default ('mem_' || gen_random_uuid()::text),
  organization_id text not null references public.organizations(organization_id)
    on update cascade on delete cascade,
  user_id uuid not null references auth.users(id) on update cascade on delete restrict,
  email extensions.citext not null,
  display_name text,
  role public.organization_role not null,
  joined_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint organization_members_id_format check (
    membership_id ~ '^mem_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint organization_members_email_length check (char_length(email::text) between 3 and 254),
  constraint organization_members_display_name_length check (
    display_name is null or char_length(display_name) between 1 and 160
  ),
  constraint organization_members_revocation_order check (
    revoked_at is null or revoked_at >= joined_at
  )
);

create unique index organization_members_user_idx
  on public.organization_members (organization_id, user_id);
create index organization_members_email_idx on public.organization_members (email);
create index organization_members_active_idx
  on public.organization_members (organization_id, role)
  where revoked_at is null;

create table public.organization_invitations (
  invitation_id text primary key default ('inv_' || gen_random_uuid()::text),
  organization_id text not null references public.organizations(organization_id)
    on update cascade on delete cascade,
  token_hash bytea not null unique,
  invited_email extensions.citext,
  role public.organization_role not null,
  created_by_user_id uuid not null references auth.users(id)
    on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_by_user_id uuid references auth.users(id)
    on update cascade on delete restrict,
  accepted_at timestamptz,
  revoked_at timestamptz,
  constraint organization_invitations_id_format check (
    invitation_id ~ '^inv_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint organization_invitations_role_check check (role <> 'owner'),
  constraint organization_invitations_expiry_order check (expires_at > created_at),
  constraint organization_invitations_acceptance_pair check (
    (accepted_by_user_id is null and accepted_at is null)
    or (accepted_by_user_id is not null and accepted_at is not null)
  )
);

create index organization_invitations_open_idx
  on public.organization_invitations (organization_id, expires_at)
  where accepted_at is null and revoked_at is null;

create table public.license_activations (
  license_id text primary key,
  subscription_id text not null references public.subscriptions(subscription_id)
    on update cascade on delete cascade,
  installation_id uuid not null,
  activated_at timestamptz not null default now(),
  last_issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint license_activations_id_format check (license_id ~ '^lic_[A-Za-z0-9_-]+$'),
  constraint license_activations_revocation_order check (
    revoked_at is null or revoked_at >= activated_at
  )
);

create unique index license_activations_subscription_installation_idx
  on public.license_activations (subscription_id, installation_id);
create index license_activations_subscription_idx
  on public.license_activations (subscription_id)
  where revoked_at is null;

create table public.device_authorizations (
  device_code_hash bytea primary key,
  user_code text not null unique,
  installation_id uuid not null,
  status public.device_authorization_status not null default 'pending',
  organization_id text references public.organizations(organization_id)
    on update cascade on delete cascade,
  approved_by_user_id uuid references auth.users(id)
    on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  constraint device_authorizations_user_code_format check (
    user_code ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'
  ),
  constraint device_authorizations_expiry_order check (expires_at > created_at),
  constraint device_authorizations_approval_pair check (
    (approved_by_user_id is null and approved_at is null)
    or (approved_by_user_id is not null and approved_at is not null)
  )
);

create index device_authorizations_expiry_idx on public.device_authorizations (expires_at);

create table public.device_sessions (
  session_id text primary key default ('dss_' || gen_random_uuid()::text),
  token_hash bytea not null unique,
  organization_id text not null references public.organizations(organization_id)
    on update cascade on delete cascade,
  user_id uuid not null references auth.users(id) on update cascade on delete restrict,
  installation_id uuid not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint device_sessions_id_format check (
    session_id ~ '^dss_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint device_sessions_expiry_order check (expires_at > created_at),
  constraint device_sessions_seen_order check (last_seen_at >= created_at),
  constraint device_sessions_revocation_order check (
    revoked_at is null or revoked_at >= created_at
  )
);

create unique index device_sessions_active_installation_idx
  on public.device_sessions (organization_id, installation_id)
  where revoked_at is null;
create index device_sessions_user_idx
  on public.device_sessions (user_id, revoked_at);

create table public.invoice_archives (
  archive_id text primary key default ('arc_' || gen_random_uuid()::text),
  organization_id text not null references public.organizations(organization_id)
    on update cascade on delete restrict,
  source_invoice_id text not null,
  revision integer not null,
  invoice_number text not null,
  issue_date date not null,
  fiscal_year_end date not null,
  paid_at date,
  correction_kind public.invoice_archive_kind not null,
  correction_reason text,
  supersedes_archive_id text references public.invoice_archives(archive_id)
    on update restrict on delete restrict,
  object_key text not null unique,
  content_sha256 text not null,
  size_bytes bigint not null,
  media_type text not null default 'application/pdf',
  previous_chain_sha256 text,
  chain_sha256 text not null,
  retention_until date not null,
  stored_by_session_id text not null references public.device_sessions(session_id)
    on update restrict on delete restrict,
  stored_at timestamptz not null default now(),
  storage_status public.invoice_archive_status not null default 'pending',
  constraint invoice_archives_id_format check (
    archive_id ~ '^arc_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint invoice_archives_source_length check (char_length(source_invoice_id) between 1 and 160),
  constraint invoice_archives_revision_range check (revision between 1 and 9999),
  constraint invoice_archives_number_length check (char_length(invoice_number) between 1 and 120),
  constraint invoice_archives_reason_length check (
    correction_reason is null or char_length(correction_reason) between 5 and 1000
  ),
  constraint invoice_archives_hash_format check (
    content_sha256 ~ '^[0-9a-f]{64}$'
    and chain_sha256 ~ '^[0-9a-f]{64}$'
    and (previous_chain_sha256 is null or previous_chain_sha256 ~ '^[0-9a-f]{64}$')
  ),
  constraint invoice_archives_size_range check (size_bytes between 1 and 12582912),
  constraint invoice_archives_media_type check (media_type = 'application/pdf'),
  constraint invoice_archives_fiscal_year_end check (
    fiscal_year_end >= issue_date
    and fiscal_year_end <= (issue_date + interval '18 months')::date
  ),
  constraint invoice_archives_retention_exact check (
    retention_until = (fiscal_year_end + interval '10 years')::date
  ),
  constraint invoice_archives_object_path check (
    object_key like ('organizations/' || organization_id || '/invoices/%')
    and object_key ~ '\.pdf$'
  )
);

create unique index invoice_archives_revision_idx
  on public.invoice_archives (organization_id, source_invoice_id, revision);
create index invoice_archives_number_idx
  on public.invoice_archives (organization_id, invoice_number);
create index invoice_archives_retention_idx
  on public.invoice_archives (retention_until)
  where storage_status = 'stored';

create table public.organization_domains (
  domain_id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations(organization_id)
    on update cascade on delete cascade,
  hostname extensions.citext not null unique,
  verification_status public.domain_verification_status not null default 'pending',
  verification_token_hash bytea not null,
  verified_at timestamptz,
  activated_at timestamptz,
  last_checked_at timestamptz,
  created_by_user_id uuid not null references auth.users(id)
    on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_domains_hostname_canonical check (
    hostname::text = lower(hostname::text)
    and char_length(hostname::text) between 4 and 253
    and hostname::text ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  constraint organization_domains_status_dates check (
    (verification_status in ('verified', 'active') and verified_at is not null)
    or (verification_status not in ('verified', 'active'))
  ),
  constraint organization_domains_activation_date check (
    verification_status <> 'active' or activated_at is not null
  )
);

create index organization_domains_org_idx on public.organization_domains (organization_id);

create table public.checkout_attempts (
  claim_hash bytea primary key,
  checkout_session_id text unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint checkout_attempts_expiry_order check (expires_at > created_at)
);

create index checkout_attempts_expiry_idx on public.checkout_attempts (expires_at);

create table public.stripe_events (
  event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  event_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processing_attempts integer not null default 0,
  processed_at timestamptz,
  constraint stripe_events_id_format check (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  constraint stripe_events_attempts_nonnegative check (processing_attempts >= 0)
);

create index stripe_events_unprocessed_idx
  on public.stripe_events (received_at)
  where processed_at is null;

create table public.stripe_webhook_proofs (
  endpoint_id text primary key,
  secret_sha256 text not null,
  livemode boolean not null,
  api_version text not null,
  last_verified_event_id text not null,
  verified_at timestamptz not null,
  constraint stripe_webhook_proofs_endpoint_format check (endpoint_id ~ '^we_[A-Za-z0-9_]+$'),
  constraint stripe_webhook_proofs_hash_format check (secret_sha256 ~ '^[0-9a-f]{64}$')
);

create table public.rate_limit_counters (
  rate_key bytea primary key,
  count integer not null default 1,
  window_started_at timestamptz not null,
  expires_at timestamptz not null,
  constraint rate_limit_counters_count_positive check (count > 0),
  constraint rate_limit_counters_expiry_order check (expires_at > window_started_at)
);

create index rate_limit_counters_expiry_idx on public.rate_limit_counters (expires_at);

create table public.security_audit_events (
  audit_id bigint generated always as identity primary key,
  organization_id text references public.organizations(organization_id)
    on update cascade on delete restrict,
  actor_user_id uuid references auth.users(id) on update cascade on delete restrict,
  actor_session_id text references public.device_sessions(session_id)
    on update restrict on delete restrict,
  event_type text not null,
  subject_type text not null,
  subject_id text,
  request_id text,
  ip_hash bytea,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint security_audit_event_type_length check (char_length(event_type) between 3 and 120),
  constraint security_audit_subject_type_length check (char_length(subject_type) between 3 and 80),
  constraint security_audit_details_object check (jsonb_typeof(details) = 'object')
);

create index security_audit_events_org_time_idx
  on public.security_audit_events (organization_id, created_at desc);

create table migration.legacy_identity_links (
  provider text not null default 'siwc',
  external_user_id text not null,
  normalized_email extensions.citext,
  supabase_user_id uuid references auth.users(id) on update cascade on delete restrict,
  linked_at timestamptz,
  linked_by_user_id uuid references auth.users(id) on update cascade on delete restrict,
  imported_at timestamptz not null default now(),
  primary key (provider, external_user_id),
  constraint legacy_identity_links_provider check (provider in ('siwc')),
  constraint legacy_identity_links_link_pair check (
    (supabase_user_id is null and linked_at is null)
    or (supabase_user_id is not null and linked_at is not null)
  )
);

create unique index legacy_identity_links_supabase_idx
  on migration.legacy_identity_links (provider, supabase_user_id)
  where supabase_user_id is not null;

create table migration.legacy_entity_map (
  entity_type text not null,
  legacy_id text not null,
  target_id text not null,
  source_sha256 text,
  imported_at timestamptz not null default now(),
  primary key (entity_type, legacy_id),
  unique (entity_type, target_id),
  constraint legacy_entity_map_type check (
    entity_type in ('organization', 'membership', 'device_session', 'invoice_archive')
  ),
  constraint legacy_entity_map_hash check (
    source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function private.set_updated_at();

create trigger organization_domains_set_updated_at
before update on public.organization_domains
for each row execute function private.set_updated_at();

create or replace function private.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, email_confirmed_at, display_name)
  values (
    new.id,
    lower(new.email),
    new.email_confirmed_at,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 160), '')
  )
  on conflict (user_id) do update
    set email = excluded.email,
        email_confirmed_at = excluded.email_confirmed_at,
        display_name = coalesce(public.profiles.display_name, excluded.display_name),
        updated_at = now();
  return new;
end;
$$;

revoke all on function private.sync_auth_user_profile() from public, anon, authenticated;

create trigger zentra_auth_user_profile_sync
after insert or update of email, email_confirmed_at, raw_user_meta_data on auth.users
for each row execute function private.sync_auth_user_profile();

create or replace function private.is_organization_member(p_organization_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members member
    where member.organization_id = p_organization_id
      and member.user_id = (select auth.uid())
      and member.revoked_at is null
  );
$$;

create or replace function private.has_organization_role(
  p_organization_id text,
  p_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members member
    where member.organization_id = p_organization_id
      and member.user_id = (select auth.uid())
      and member.role = any(p_roles)
      and member.revoked_at is null
  );
$$;

revoke all on function private.is_organization_member(text) from public, anon, authenticated;
revoke all on function private.has_organization_role(text, public.organization_role[]) from public, anon, authenticated;
grant execute on function private.is_organization_member(text) to authenticated;
grant execute on function private.has_organization_role(text, public.organization_role[]) to authenticated;

create or replace function private.guard_last_organization_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  removes_owner boolean := false;
begin
  if tg_op = 'DELETE' then
    removes_owner := old.role = 'owner' and old.revoked_at is null;
  else
    removes_owner := old.role = 'owner'
      and old.revoked_at is null
      and (new.role <> 'owner' or new.revoked_at is not null);
  end if;

  if removes_owner then
    -- Serialize owner changes for the same organization. Without this lock,
    -- two concurrent demotions could each observe the other owner.
    perform 1
    from public.organizations organization
    where organization.organization_id = old.organization_id
    for update;
  end if;

  if removes_owner and not exists (
    select 1
    from public.organization_members other_member
    where other_member.organization_id = old.organization_id
      and other_member.membership_id <> old.membership_id
      and other_member.role = 'owner'
      and other_member.revoked_at is null
  ) then
    raise exception 'an organization must keep an active owner' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_last_organization_owner() from public, anon, authenticated;

create trigger organization_members_last_owner_guard
before update of role, revoked_at or delete on public.organization_members
for each row execute function private.guard_last_organization_owner();

create or replace function private.validate_invoice_archive_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous public.invoice_archives%rowtype;
begin
  if new.revision = 1 then
    if new.correction_kind <> 'initial'
      or new.correction_reason is not null
      or new.previous_chain_sha256 is not null
      or new.supersedes_archive_id is not null then
      raise exception 'first archive revision must be an initial immutable version' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.correction_kind <> 'correction' or new.correction_reason is null then
    raise exception 'later archive revisions require a correction reason' using errcode = '23514';
  end if;

  select * into previous
  from public.invoice_archives candidate
  where candidate.organization_id = new.organization_id
    and candidate.source_invoice_id = new.source_invoice_id
    and candidate.revision = new.revision - 1
    and candidate.storage_status = 'stored';

  if not found
    or new.supersedes_archive_id is distinct from previous.archive_id
    or new.previous_chain_sha256 is distinct from previous.chain_sha256 then
    raise exception 'archive revision chain is incomplete or invalid' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_invoice_archive_revision() from public, anon, authenticated;

create trigger invoice_archives_revision_guard
before insert on public.invoice_archives
for each row execute function private.validate_invoice_archive_revision();

create or replace function private.guard_invoice_archive_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.storage_status = 'pending'
    and new.storage_status = 'stored'
    and (to_jsonb(new) - 'storage_status') = (to_jsonb(old) - 'storage_status') then
    return new;
  end if;
  raise exception 'stored invoice archive metadata is immutable' using errcode = '55000';
end;
$$;

create or replace function private.guard_invoice_archive_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.storage_status = 'pending' then
    return old;
  end if;
  raise exception 'stored invoice archives cannot be deleted' using errcode = '55000';
end;
$$;

revoke all on function private.guard_invoice_archive_update() from public, anon, authenticated;
revoke all on function private.guard_invoice_archive_delete() from public, anon, authenticated;

create trigger invoice_archives_immutable_update_guard
before update on public.invoice_archives
for each row execute function private.guard_invoice_archive_update();

create trigger invoice_archives_immutable_delete_guard
before delete on public.invoice_archives
for each row execute function private.guard_invoice_archive_delete();

create or replace function private.guard_security_audit_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'security audit events are append-only' using errcode = '55000';
end;
$$;

revoke all on function private.guard_security_audit_append_only() from public, anon, authenticated;

create trigger security_audit_events_append_only
before update or delete on public.security_audit_events
for each row execute function private.guard_security_audit_append_only();

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.license_activations enable row level security;
alter table public.device_authorizations enable row level security;
alter table public.device_sessions enable row level security;
alter table public.invoice_archives enable row level security;
alter table public.organization_domains enable row level security;
alter table public.checkout_attempts enable row level security;
alter table public.stripe_events enable row level security;
alter table public.stripe_webhook_proofs enable row level security;
alter table public.rate_limit_counters enable row level security;
alter table public.security_audit_events enable row level security;

create policy profiles_read_self
on public.profiles for select to authenticated
using (user_id = (select auth.uid()));

create policy profiles_update_self
on public.profiles for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy organizations_read_member
on public.organizations for select to authenticated
using ((select private.is_organization_member(organization_id)));

create policy organization_members_read_member
on public.organization_members for select to authenticated
using ((select private.is_organization_member(organization_id)));

create policy organization_invitations_read_manager
on public.organization_invitations for select to authenticated
using ((select private.has_organization_role(
  organization_id,
  array['owner', 'admin']::public.organization_role[]
)));

create policy device_sessions_read_member
on public.device_sessions for select to authenticated
using ((select private.is_organization_member(organization_id)));

create policy invoice_archives_read_member
on public.invoice_archives for select to authenticated
using ((select private.is_organization_member(organization_id)));

create policy organization_domains_read_member
on public.organization_domains for select to authenticated
using ((select private.is_organization_member(organization_id)));

revoke all on public.profiles from anon, authenticated;
revoke all on public.subscriptions from anon, authenticated;
revoke all on public.organizations from anon, authenticated;
revoke all on public.organization_members from anon, authenticated;
revoke all on public.organization_invitations from anon, authenticated;
revoke all on public.license_activations from anon, authenticated;
revoke all on public.device_authorizations from anon, authenticated;
revoke all on public.device_sessions from anon, authenticated;
revoke all on public.invoice_archives from anon, authenticated;
revoke all on public.organization_domains from anon, authenticated;
revoke all on public.checkout_attempts from anon, authenticated;
revoke all on public.stripe_events from anon, authenticated;
revoke all on public.stripe_webhook_proofs from anon, authenticated;
revoke all on public.rate_limit_counters from anon, authenticated;
revoke all on public.security_audit_events from anon, authenticated;

grant select (user_id, email, email_confirmed_at, display_name, created_at, updated_at)
  on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select (
  invitation_id, organization_id, invited_email, role, created_by_user_id,
  created_at, expires_at, accepted_by_user_id, accepted_at, revoked_at
) on public.organization_invitations to authenticated;
grant select (
  session_id, organization_id, user_id, installation_id,
  created_at, last_seen_at, expires_at, revoked_at
) on public.device_sessions to authenticated;
grant select on public.invoice_archives to authenticated;
grant select (
  domain_id, organization_id, hostname, verification_status, verified_at,
  activated_at, last_checked_at, created_by_user_id, created_at, updated_at
) on public.organization_domains to authenticated;

grant usage on type public.organization_role to authenticated;
grant usage on type public.invoice_archive_kind to authenticated;
grant usage on type public.invoice_archive_status to authenticated;
grant usage on type public.domain_verification_status to authenticated;

commit;
