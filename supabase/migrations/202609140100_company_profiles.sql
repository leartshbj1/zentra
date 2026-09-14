begin;
create table if not exists public.zentra_company_profiles (
  organization_id text primary key check (length(organization_id) between 4 and 100),
  profile jsonb not null check (jsonb_typeof(profile) = 'object' and octet_length(profile::text) <= 32768),
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table public.zentra_company_profiles enable row level security;
revoke all on public.zentra_company_profiles from anon, authenticated;
grant select,insert,update,delete on public.zentra_company_profiles to service_role;
comment on table public.zentra_company_profiles is 'Company setup identity. Server validates active device membership and subscription in the account ledger; no direct client access.';
commit;
