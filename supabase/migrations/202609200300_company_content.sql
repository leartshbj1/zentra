begin;

alter table public.zentra_workspace_snapshots add column content_version integer not null default 0 check(content_version in(0,1));
alter table public.zentra_workspace_snapshots add column content_digest text;
create table public.zentra_workspace_content_parts(
 organization_id text not null,snapshot_id uuid not null,part_index integer not null check(part_index between 0 and 8191),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),size_bytes integer not null check(size_bytes between 1 and 1048576),
 primary key(organization_id,snapshot_id,part_index),
 foreign key(organization_id,snapshot_id) references public.zentra_workspace_snapshots on delete cascade
);
create index zentra_content_part_hash on public.zentra_workspace_content_parts(organization_id,sha256,snapshot_id);
create table public.zentra_workspace_content_blobs(
 organization_id text not null references public.zentra_workspaces,sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes integer not null check(size_bytes between 1 and 1048576),state text not null check(state in('uploading','ready','deleting')),storage_key uuid not null default gen_random_uuid(),
 created_at timestamptz not null default now(),primary key(organization_id,sha256)
);
alter table public.zentra_workspace_content_parts enable row level security;
alter table public.zentra_workspace_content_blobs enable row level security;
revoke all on public.zentra_workspace_content_parts,public.zentra_workspace_content_blobs from anon,authenticated;
grant select,insert,update,delete on public.zentra_workspace_content_parts,public.zentra_workspace_content_blobs to service_role;

create function public.zentra_prepare_content(p_organization text,p_snapshot uuid,p_installation text,p_actor text,p_base bigint,p_manifest jsonb,p_entries jsonb,p_digest text,p_activate boolean,p_numbers jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare h public.zentra_workspaces; s public.zentra_workspace_snapshots; missing jsonb; total bigint;
begin
 if jsonb_typeof(p_entries) is distinct from 'array' or p_digest is null or p_base is null or p_base<0 then raise exception 'invalid_content_manifest'; end if;
 if jsonb_array_length(p_entries) not between 1 and 8192 or p_digest !~ '^[0-9a-f]{64}$'
    or exists(select 1 from jsonb_array_elements(p_entries) e where e->>'sha256' is null or e->>'sha256' !~ '^[0-9a-f]{64}$' or e->>'size_bytes' is null or (e->>'size_bytes')::integer not between 1 and 1048576)
 then raise exception 'invalid_content_manifest'; end if;
 select sum((e->>'size_bytes')::bigint) into total from jsonb_array_elements(p_entries) e;
 if total not between 1 and 536870912 or total is distinct from (p_manifest->>'size_bytes')::bigint then raise exception 'invalid_content_size'; end if;
 if p_activate and p_base=0 then insert into public.zentra_workspaces(organization_id,updated_by,number_floors) values(p_organization,p_actor,p_numbers) on conflict do nothing; end if;
 select * into h from public.zentra_workspaces where organization_id=p_organization for update;
 if h.organization_id is null then raise exception 'workspace_not_ready'; end if;
 select * into s from public.zentra_workspace_snapshots where organization_id=p_organization and id=p_snapshot;
 if s.id is not null then
   if s.installation_id<>p_installation or s.created_by<>p_actor or s.base_revision<>p_base or s.manifest<>p_manifest or s.content_version<>1 or s.content_digest is distinct from p_digest then raise exception 'content_request_mismatch'; end if;
 else
   if h.revision<>p_base then return jsonb_build_object('conflict',true,'revision',h.revision); end if;
   if (select count(*) from public.zentra_workspace_snapshots where organization_id=p_organization)>=1000 then raise exception 'content_history_full'; end if;
   insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes,content_version,content_digest)
    values(p_organization,p_snapshot,p_installation,p_actor,p_base,p_manifest,total,1,p_digest);
   insert into public.zentra_workspace_content_parts(organization_id,snapshot_id,part_index,sha256,size_bytes)
    select p_organization,p_snapshot,ordinality-1,value->>'sha256',(value->>'size_bytes')::integer from jsonb_array_elements(p_entries) with ordinality;
 end if;
 select coalesce(jsonb_agg(x.sha256),'[]'::jsonb) into missing from(
   select distinct p.sha256 from public.zentra_workspace_content_parts p left join public.zentra_workspace_content_blobs b on b.organization_id=p.organization_id and b.sha256=p.sha256
   where p.organization_id=p_organization and p.snapshot_id=p_snapshot and (b.state is distinct from 'ready' or b.size_bytes<>p.size_bytes)
 )x;
 return jsonb_build_object('id',p_snapshot,'revision',s.revision,'missing',missing,'contentTransfer',1);
end $$;

create function public.zentra_reserve_content_blob(p_organization text,p_snapshot uuid,p_installation text,p_actor text,p_hash text,p_size integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.zentra_workspace_content_blobs;
begin
 perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
 if not exists(select 1 from public.zentra_workspace_snapshots s join public.zentra_workspace_content_parts p on p.organization_id=s.organization_id and p.snapshot_id=s.id
  where s.organization_id=p_organization and s.id=p_snapshot and s.installation_id=p_installation and s.created_by=p_actor and p.sha256=p_hash and p.size_bytes=p_size)
 then raise exception 'content_not_found'; end if;
 select * into b from public.zentra_workspace_content_blobs where organization_id=p_organization and sha256=p_hash;
 if b.sha256 is not null then
   if b.size_bytes<>p_size then raise exception 'content_size_mismatch'; end if;
   if b.state='deleting' then raise exception 'content_cleanup_pending'; end if;
   return jsonb_build_object('ready',b.state='ready','storageKey',b.storage_key);
 end if;
 if (select coalesce(sum(size_bytes),0) from public.zentra_workspace_content_blobs where organization_id=p_organization)+p_size>2147483648 then raise exception 'content_storage_full'; end if;
 insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state) values(p_organization,p_hash,p_size,'uploading') returning * into b;
 return jsonb_build_object('ready',false,'storageKey',b.storage_key);
end $$;

-- Garbage collection serializes with preparation and reservation. A deleting
-- hash cannot be reused until its old object deletion has completed.
create function public.zentra_claim_content_cleanup(p_organization text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare hashes jsonb;
begin
 perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
 with candidates as(select b.sha256 from public.zentra_workspace_content_blobs b where b.organization_id=p_organization and
  (b.state='deleting' or (b.created_at<now()-interval '1 hour' and not exists(select 1 from public.zentra_workspace_content_parts p where p.organization_id=b.organization_id and p.sha256=b.sha256))) order by b.created_at limit 16),
 marked as(update public.zentra_workspace_content_blobs b set state='deleting' where b.organization_id=p_organization and b.sha256 in(select sha256 from candidates) returning b.sha256,b.storage_key)
 select coalesce(jsonb_agg(to_jsonb(marked)),'[]'::jsonb) into hashes from marked;
 return hashes;
end $$;

create or replace function public.zentra_commit_workspace(p_organization text,p_snapshot uuid,p_installation text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare head public.zentra_workspaces; candidate public.zentra_workspace_snapshots; part jsonb; ordinal bigint;
begin
 select * into head from public.zentra_workspaces where organization_id=p_organization for update;
 select * into candidate from public.zentra_workspace_snapshots where organization_id=p_organization and id=p_snapshot and installation_id=p_installation and created_by=p_actor for update;
 if head.organization_id is null or candidate.id is null then raise exception 'workspace_not_found'; end if;
 if candidate.revision is not null then return jsonb_build_object('committed',true,'revision',candidate.revision,'snapshotId',candidate.id); end if;
 if candidate.base_revision<>head.revision then return jsonb_build_object('committed',false,'conflict',true,'revision',head.revision,'snapshotId',head.snapshot_id); end if;
 if candidate.content_version=1 then
   if (select coalesce(sum(size_bytes),0) from public.zentra_workspace_content_parts where organization_id=p_organization and snapshot_id=p_snapshot)<>candidate.size_bytes
    or exists(select 1 from public.zentra_workspace_content_parts p left join public.zentra_workspace_content_blobs b on b.organization_id=p.organization_id and b.sha256=p.sha256
      where p.organization_id=p_organization and p.snapshot_id=p_snapshot and (b.state is distinct from 'ready' or b.size_bytes<>p.size_bytes))
   then raise exception 'workspace_incomplete'; end if;
 else
   for part,ordinal in select value,ordinality from jsonb_array_elements(candidate.manifest->'chunks') with ordinality loop
     if not exists(select 1 from public.zentra_workspace_chunks where organization_id=p_organization and snapshot_id=p_snapshot and chunk_index=ordinal-1 and sha256=part->>'sha256' and size_bytes=(part->>'size_bytes')::integer) then raise exception 'workspace_incomplete'; end if;
   end loop;
 end if;
 update public.zentra_workspace_snapshots set revision=head.revision+1 where organization_id=p_organization and id=p_snapshot;
 update public.zentra_workspaces set revision=head.revision+1,snapshot_id=p_snapshot,updated_by=p_actor,updated_at=now() where organization_id=p_organization;
 return jsonb_build_object('committed',true,'revision',head.revision+1,'snapshotId',p_snapshot);
end $$;
revoke all on function public.zentra_prepare_content(text,uuid,text,text,bigint,jsonb,jsonb,text,boolean,jsonb),public.zentra_reserve_content_blob(text,uuid,text,text,text,integer),public.zentra_claim_content_cleanup(text) from public,anon,authenticated;
grant execute on function public.zentra_prepare_content(text,uuid,text,text,bigint,jsonb,jsonb,text,boolean,jsonb),public.zentra_reserve_content_blob(text,uuid,text,text,text,integer),public.zentra_claim_content_cleanup(text) to service_role;
commit;
