begin;

-- Access stays behind the account gateway: its active device session supplies
-- the organization and actor. No browser or installation gets a service key.
create table public.zentra_workspaces (
  organization_id text primary key,
  revision bigint not null default 0 check (revision >= 0),
  snapshot_id uuid,
  number_floors jsonb not null default '[]'::jsonb,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
create table public.zentra_workspace_snapshots (
  organization_id text not null references public.zentra_workspaces,
  id uuid not null,
  installation_id text not null,
  created_by text not null,
  base_revision bigint not null check (base_revision >= 0),
  revision bigint,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 32768),
  size_bytes bigint not null check (size_bytes between 1 and 536870912),
  created_at timestamptz not null default now(),
  primary key (organization_id,id),
  unique (organization_id,revision)
);
create table public.zentra_workspace_chunks (
  organization_id text not null,
  snapshot_id uuid not null,
  chunk_index integer not null check (chunk_index between 0 and 63),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  primary key (organization_id,snapshot_id,chunk_index),
  foreign key (organization_id,snapshot_id) references public.zentra_workspace_snapshots on delete cascade
);
alter table public.zentra_workspaces enable row level security;
alter table public.zentra_workspace_snapshots enable row level security;
alter table public.zentra_workspace_chunks enable row level security;
revoke all on public.zentra_workspaces,public.zentra_workspace_snapshots,public.zentra_workspace_chunks from anon,authenticated;
grant select,insert,update,delete on public.zentra_workspaces,public.zentra_workspace_snapshots,public.zentra_workspace_chunks to service_role;

create function public.zentra_commit_workspace(p_organization text,p_snapshot uuid,p_installation text,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare head public.zentra_workspaces; candidate public.zentra_workspace_snapshots; part jsonb; ordinal bigint;
begin
  select * into head from public.zentra_workspaces where organization_id=p_organization for update;
  select * into candidate from public.zentra_workspace_snapshots
    where organization_id=p_organization and id=p_snapshot and installation_id=p_installation and created_by=p_actor for update;
  if head.organization_id is null or candidate.id is null then raise exception 'workspace_not_found'; end if;
  if candidate.revision is not null then return jsonb_build_object('committed',true,'revision',candidate.revision,'snapshotId',candidate.id); end if;
  if candidate.base_revision <> head.revision then
    return jsonb_build_object('committed',false,'conflict',true,'revision',head.revision,'snapshotId',head.snapshot_id);
  end if;
  for part,ordinal in select value,ordinality from jsonb_array_elements(candidate.manifest->'chunks') with ordinality loop
    if not exists(select 1 from public.zentra_workspace_chunks where organization_id=p_organization and snapshot_id=p_snapshot
      and chunk_index=ordinal-1 and sha256=part->>'sha256' and size_bytes=(part->>'size_bytes')::integer)
      then raise exception 'workspace_incomplete'; end if;
  end loop;
  update public.zentra_workspace_snapshots set revision=head.revision+1 where organization_id=p_organization and id=p_snapshot;
  update public.zentra_workspaces set revision=head.revision+1,snapshot_id=p_snapshot,updated_by=p_actor,updated_at=now() where organization_id=p_organization;
  return jsonb_build_object('committed',true,'revision',head.revision+1,'snapshotId',p_snapshot);
end $$;
revoke all on function public.zentra_commit_workspace(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.zentra_commit_workspace(text,uuid,text,text) to service_role;

create table public.zentra_workspace_number_reservations (
 organization_id text not null references public.zentra_workspaces,
 request_id uuid not null,installation_id text not null,prefix text not null,year integer not null,
 minimum bigint not null,count integer not null,start_value bigint not null,end_value bigint not null,
 primary key(organization_id,request_id)
);
alter table public.zentra_workspace_number_reservations enable row level security;
revoke all on public.zentra_workspace_number_reservations from anon,authenticated;
grant select,insert on public.zentra_workspace_number_reservations to service_role;
create function public.zentra_reserve_workspace_numbers(p_organization text,p_installation text,p_request uuid,p_prefix text,p_year integer,p_minimum bigint,p_count integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare head public.zentra_workspaces; saved public.zentra_workspace_number_reservations; first_number bigint; floor_number bigint;
begin
 if p_prefix !~ '^[A-Z0-9-]{1,12}$' or p_year not between 1900 and 9999 or p_minimum<1 or p_count not between 1 and 1000 then raise exception 'invalid_number_request'; end if;
 select * into head from public.zentra_workspaces where organization_id=p_organization for update;
 if head.revision is null or head.revision=0 then raise exception 'workspace_not_ready'; end if;
 select * into saved from public.zentra_workspace_number_reservations where organization_id=p_organization and request_id=p_request;
 if saved.request_id is not null then
   if saved.installation_id<>p_installation or saved.prefix<>p_prefix or saved.year<>p_year or saved.minimum<>p_minimum or saved.count<>p_count then raise exception 'number_request_mismatch'; end if;
   return to_jsonb(saved);
 end if;
 select coalesce(max((value->>'minimum')::bigint),1) into floor_number from jsonb_array_elements(head.number_floors) where value->>'prefix'=p_prefix and (value->>'year')::integer=p_year;
 select greatest(coalesce(max(end_value)+1,1),p_minimum,floor_number) into first_number from public.zentra_workspace_number_reservations where organization_id=p_organization and prefix=p_prefix and year=p_year;
 if first_number+p_count-1>999999999 then raise exception 'number_range_exhausted'; end if;
 insert into public.zentra_workspace_number_reservations values(p_organization,p_request,p_installation,p_prefix,p_year,p_minimum,p_count,first_number,first_number+p_count-1) returning * into saved;
 return to_jsonb(saved);
end $$;
revoke all on function public.zentra_reserve_workspace_numbers(text,text,uuid,text,integer,bigint,integer) from public,anon,authenticated;
grant execute on function public.zentra_reserve_workspace_numbers(text,text,uuid,text,integer,bigint,integer) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('zentra-company-data','zentra-company-data',false,8388608,array['application/octet-stream'])
on conflict (id) do nothing;
commit;
