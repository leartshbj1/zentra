-- A4 local/staging proposal only. No organization is opted in by this migration.
-- D1 owns admission/source/barrier serialization; these RPCs only fence the
-- PostgreSQL half. A service-only operation UUID is NOT evidence of a D1 grant.
begin;

do $$ begin
  if pg_catalog.to_regprocedure('zentra_admission_private.zentra_commit_workspace(text,uuid,text,text)') is null
    or pg_catalog.to_regprocedure('public.zentra_assert_legacy_workspace_writable_v1(text)') is null then
    raise exception 'Reconciled legacy country-guarded collaboration schema required';
  end if;
end $$;

create table public.zentra_action_publication_guards (
  organization_id text primary key references public.zentra_workspaces(organization_id) on delete restrict,
  enabled_at timestamptz not null default now()
);
create table public.zentra_action_publication_operations (
  operation_id uuid primary key,
  organization_id text not null references public.zentra_action_publication_guards(organization_id) on delete restrict,
  snapshot_id uuid not null,
  installation_id text not null check(length(installation_id) between 1 and 160),
  actor_id text not null check(length(actor_id) between 1 and 160),
  base_revision bigint not null check(base_revision between 0 and 9007199254740990),
  state text not null check(state in ('pending','committed','cancelled')),
  publication_revision bigint,
  result_revision bigint,
  result_snapshot_id uuid,
  candidate_manifest jsonb,
  candidate_size_bytes bigint,
  candidate_content_version integer,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check((state='committed')=(publication_revision is not null)),
  check(publication_revision is null or (publication_revision=base_revision+1 and publication_revision<=9007199254740991)),
  check((state='pending')=(closed_at is null)),
  check((state='pending' and result_revision is null and result_snapshot_id is null)
    or (state<>'pending' and result_revision is not null and result_revision between 0 and 9007199254740991)),
  check(state<>'committed' or (result_snapshot_id is not null and result_revision=publication_revision and result_snapshot_id=snapshot_id)),
  check((candidate_manifest is null and candidate_size_bytes is null and candidate_content_version is null and state='cancelled')
    or (candidate_manifest is not null and jsonb_typeof(candidate_manifest)='object'
      and octet_length(candidate_manifest::text)<=32768 and candidate_size_bytes is not null
      and candidate_size_bytes between 1 and 536870912 and candidate_content_version is not null
      and candidate_content_version in (0,1)))
);
create index zentra_action_publication_snapshot on public.zentra_action_publication_operations(organization_id,snapshot_id);

-- No service-role table write grant: a caller cannot manufacture this marker
-- with SET LOCAL or an HTTP parameter. Only the private definer creates it.
-- txid_current is the database-wide 64-bit transaction identity, not a lease.
create table zentra_admission_private.action_publication_context (
  transaction_id bigint not null,
  organization_id text not null,
  operation_id uuid not null references public.zentra_action_publication_operations(operation_id) on delete restrict,
  primary key(transaction_id,organization_id)
);
alter table public.zentra_action_publication_guards enable row level security;
alter table public.zentra_action_publication_operations enable row level security;
alter table zentra_admission_private.action_publication_context enable row level security;
revoke all on public.zentra_action_publication_guards,public.zentra_action_publication_operations,
  zentra_admission_private.action_publication_context from public,anon,authenticated,service_role;
grant select on public.zentra_action_publication_guards,public.zentra_action_publication_operations to service_role;
create policy zentra_action_publication_guard_read on public.zentra_action_publication_guards for select to service_role using(true);
create policy zentra_action_publication_operation_read on public.zentra_action_publication_operations for select to service_role using(true);

-- The private core returns historical success before writing any row. A trigger
-- alone therefore cannot force a lost-ACK retry through D1 reconciliation once
-- the rollout flag is removed. Refuse ALL legacy branches for guarded companies
-- before invoking that core, including historical replays. Lock in the same
-- order as enable/v2 so a concurrent opt-in cannot race this guard observation.
create or replace function public.zentra_commit_workspace(p_organization text,p_snapshot uuid,p_installation text,p_actor text)
returns jsonb language plpgsql security invoker set search_path='' as $$ begin
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  perform 1 from public.zentra_workspaces where organization_id=p_organization for update;
  if exists(select 1 from public.zentra_action_publication_guards where organization_id=p_organization) then
    raise exception using errcode='PA103',message='Coordinated publication requires its server operation';
  end if;
  return zentra_admission_private.zentra_commit_workspace(p_organization,p_snapshot,p_installation,p_actor);
end $$;
revoke all on function public.zentra_commit_workspace(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.zentra_commit_workspace(text,uuid,text,text) to service_role;

create function zentra_admission_private.action_publication_immutable_v1()
returns trigger language plpgsql security definer set search_path='' as $$ begin
  if tg_table_name='zentra_action_publication_guards' or tg_op='DELETE' then
    raise exception using errcode='PA101',message='Publication coordination is permanent';
  end if;
  if old.state<>'pending' or new.state not in ('committed','cancelled')
    or row(new.operation_id,new.organization_id,new.snapshot_id,new.installation_id,new.actor_id,new.base_revision,
      new.candidate_manifest,new.candidate_size_bytes,new.candidate_content_version,new.created_at)
      is distinct from row(old.operation_id,old.organization_id,old.snapshot_id,old.installation_id,old.actor_id,old.base_revision,
      old.candidate_manifest,old.candidate_size_bytes,old.candidate_content_version,old.created_at) then
    raise exception using errcode='PA101',message='Publication operation is immutable';
  end if;
  return new;
end $$;
create trigger zentra_action_publication_guard_permanent before update or delete on public.zentra_action_publication_guards
for each row execute function zentra_admission_private.action_publication_immutable_v1();
create trigger zentra_action_publication_operation_permanent before update or delete on public.zentra_action_publication_operations
for each row execute function zentra_admission_private.action_publication_immutable_v1();

create function zentra_admission_private.action_publication_write_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_organization text; v_operation public.zentra_action_publication_operations%rowtype;
begin
  v_organization:=case when tg_op='DELETE' then old.organization_id else new.organization_id end;
  if tg_op='UPDATE' and old.organization_id is distinct from new.organization_id
    and exists(select 1 from public.zentra_action_publication_guards where organization_id in (old.organization_id,new.organization_id)) then
    raise exception using errcode='PA102',message='Coordinated organization identity is immutable';
  end if;
  if not exists(select 1 from public.zentra_action_publication_guards where organization_id=v_organization) then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_name='zentra_workspaces' then
    if tg_op='DELETE' then raise exception using errcode='PA102',message='Coordinated head cannot be deleted'; end if;
    if new.revision is not distinct from old.revision and new.snapshot_id is not distinct from old.snapshot_id then return new; end if;
  else
    if tg_op='INSERT' then
      if new.revision is not null then raise exception using errcode='PA102',message='A new candidate cannot claim publication'; end if;
      if exists(select 1 from public.zentra_action_publication_operations where organization_id=new.organization_id and snapshot_id=new.id) then
        raise exception using errcode='PA102',message='A coordinated snapshot identity cannot be reused';
      end if;
      return new;
    end if;
    if tg_op='DELETE' then
      if old.revision is null then
        raise exception using errcode='PA102',message='An unpublished coordinated candidate cannot be replaced';
      end if;
      if exists(select 1 from public.zentra_workspaces where organization_id=old.organization_id and snapshot_id=old.id) then
        raise exception using errcode='PA102',message='The current publication cannot be pruned';
      end if;
      return old;
    end if;
    if row(new.organization_id,new.id,new.installation_id,new.created_by,new.base_revision,new.manifest,new.size_bytes,new.content_version,new.content_digest,new.created_at)
      is distinct from row(old.organization_id,old.id,old.installation_id,old.created_by,old.base_revision,old.manifest,old.size_bytes,old.content_version,old.content_digest,old.created_at) then
      raise exception using errcode='PA102',message='Coordinated candidate is immutable';
    end if;
    if new.revision is not distinct from old.revision then return new; end if;
  end if;
  select operation.* into v_operation
    from zentra_admission_private.action_publication_context context
    join public.zentra_action_publication_operations operation on operation.operation_id=context.operation_id
    where context.transaction_id=pg_catalog.txid_current() and context.organization_id=v_organization
      and operation.organization_id=v_organization and operation.state='pending';
  if not found then raise exception using errcode='PA103',message='Publication requires the coordinated gateway'; end if;
  if tg_table_name='zentra_workspaces' then
    if old.revision<>v_operation.base_revision or new.revision<>v_operation.base_revision+1
      or new.snapshot_id is distinct from v_operation.snapshot_id or new.updated_by is distinct from v_operation.actor_id then
      raise exception using errcode='PA103',message='Publication does not match its operation';
    end if;
  else
    if old.revision is not null or new.revision<>v_operation.base_revision+1
      or new.id is distinct from v_operation.snapshot_id or new.installation_id is distinct from v_operation.installation_id
      or new.created_by is distinct from v_operation.actor_id or new.base_revision<>v_operation.base_revision
      or new.manifest is distinct from v_operation.candidate_manifest or new.size_bytes<>v_operation.candidate_size_bytes
      or new.content_version<>v_operation.candidate_content_version then
      raise exception using errcode='PA103',message='Candidate publication does not match its operation';
    end if;
  end if;
  return new;
end $$;
create trigger zentra_action_publication_head_guard before update or delete on public.zentra_workspaces
for each row execute function zentra_admission_private.action_publication_write_guard_v1();
create trigger zentra_action_publication_candidate_guard before insert or update or delete on public.zentra_workspace_snapshots
for each row execute function zentra_admission_private.action_publication_write_guard_v1();

create function zentra_admission_private.assert_action_publication_identity_v1(
  p_organization text,p_snapshot uuid,p_installation text,p_actor text,p_base bigint,p_operation uuid
) returns void language plpgsql security invoker set search_path='' as $$ begin
  if p_organization is null or length(p_organization) not between 1 and 160 or p_organization~'[[:cntrl:]]'
    or p_snapshot is null or p_operation is null
    or p_installation is null or length(p_installation) not between 1 and 160 or p_installation~'[[:cntrl:]]'
    or p_actor is null or length(p_actor) not between 1 and 160 or p_actor~'[[:cntrl:]]'
    or p_base is null or p_base not between 0 and 9007199254740990 then
    raise exception using errcode='PA104',message='Invalid publication identity';
  end if;
end $$;

create function public.zentra_enable_action_publication_guard_v1(p_organization text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_head public.zentra_workspaces%rowtype;
begin
  if p_organization is null or length(p_organization) not between 1 and 160 or p_organization~'[[:cntrl:]]' then
    raise exception using errcode='PA104',message='Invalid publication organization';
  end if;
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  select * into v_head from public.zentra_workspaces where organization_id=p_organization for update;
  if not found then raise exception using errcode='PA105',message='Publication workspace not found'; end if;
  insert into public.zentra_action_publication_guards(organization_id) values(p_organization) on conflict do nothing;
  return jsonb_build_object('guarded',true,'revision',v_head.revision,'snapshotId',v_head.snapshot_id);
end $$;

create function public.zentra_commit_workspace_v2(
  p_organization text,p_snapshot uuid,p_installation text,p_actor text,p_base bigint,p_operation uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_head public.zentra_workspaces%rowtype; v_candidate public.zentra_workspace_snapshots%rowtype;
  v_operation public.zentra_action_publication_operations%rowtype; v_result jsonb;
begin
  perform zentra_admission_private.assert_action_publication_identity_v1(p_organization,p_snapshot,p_installation,p_actor,p_base,p_operation);
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  select * into v_head from public.zentra_workspaces where organization_id=p_organization for update;
  if not found then raise exception using errcode='PA105',message='Publication workspace not found'; end if;
  if not exists(select 1 from public.zentra_action_publication_guards where organization_id=p_organization) then
    raise exception using errcode='PA106',message='Publication coordination has not been enabled';
  end if;
  select * into v_operation from public.zentra_action_publication_operations where operation_id=p_operation for update;
  if found then
    if row(v_operation.organization_id,v_operation.snapshot_id,v_operation.installation_id,v_operation.actor_id,v_operation.base_revision)
      is distinct from row(p_organization,p_snapshot,p_installation,p_actor,p_base) then
      raise exception using errcode='PA107',message='Publication operation identity mismatch';
    end if;
    if v_operation.state='committed' then
      return jsonb_build_object('committed',true,'revision',v_operation.publication_revision,'snapshotId',v_operation.snapshot_id);
    end if;
    if v_operation.state='cancelled' then
      return jsonb_build_object('committed',false,'revision',v_operation.result_revision,'snapshotId',v_operation.result_snapshot_id,'cancelled',true,'conflict',true);
    end if;
  end if;
  select * into v_candidate from public.zentra_workspace_snapshots where organization_id=p_organization and id=p_snapshot for update;
  if not found then raise exception using errcode='PA105',message='Publication candidate not found'; end if;
  if row(v_candidate.installation_id,v_candidate.created_by,v_candidate.base_revision)
    is distinct from row(p_installation,p_actor,p_base) then
    raise exception using errcode='PA107',message='Publication candidate identity mismatch';
  end if;
  if v_operation.operation_id is null then
    insert into public.zentra_action_publication_operations(operation_id,organization_id,snapshot_id,installation_id,actor_id,base_revision,state,
      candidate_manifest,candidate_size_bytes,candidate_content_version)
      values(p_operation,p_organization,p_snapshot,p_installation,p_actor,p_base,'pending',v_candidate.manifest,v_candidate.size_bytes,v_candidate.content_version);
  elsif row(v_operation.candidate_manifest,v_operation.candidate_size_bytes,v_operation.candidate_content_version)
    is distinct from row(v_candidate.manifest,v_candidate.size_bytes,v_candidate.content_version) then
    raise exception using errcode='PA107',message='Publication candidate content mismatch';
  end if;
  insert into zentra_admission_private.action_publication_context(transaction_id,organization_id,operation_id)
    values(pg_catalog.txid_current(),p_organization,p_operation);
  -- The existing core verifies all uploaded parts and performs the same locked
  -- head CAS. Its historical branch does not advance a newer head.
  v_result:=zentra_admission_private.zentra_commit_workspace(p_organization,p_snapshot,p_installation,p_actor);
  delete from zentra_admission_private.action_publication_context where transaction_id=pg_catalog.txid_current() and organization_id=p_organization;
  if v_result->'committed'='true'::jsonb then
    update public.zentra_action_publication_operations set state='committed',publication_revision=(v_result->>'revision')::bigint,
      result_revision=(v_result->>'revision')::bigint,result_snapshot_id=p_snapshot,closed_at=now()
      where operation_id=p_operation;
    return jsonb_build_object('committed',true,'revision',(v_result->>'revision')::bigint,'snapshotId',p_snapshot);
  end if;
  update public.zentra_action_publication_operations set state='cancelled',result_revision=v_head.revision,
    result_snapshot_id=v_head.snapshot_id,closed_at=now() where operation_id=p_operation;
  return jsonb_build_object('committed',false,'revision',v_head.revision,'snapshotId',v_head.snapshot_id,'cancelled',true,'conflict',true);
end $$;

create function public.zentra_close_action_publication_v1(
  p_organization text,p_snapshot uuid,p_installation text,p_actor text,p_base bigint,p_operation uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_head public.zentra_workspaces%rowtype; v_candidate public.zentra_workspace_snapshots%rowtype;
  v_operation public.zentra_action_publication_operations%rowtype;
begin
  perform zentra_admission_private.assert_action_publication_identity_v1(p_organization,p_snapshot,p_installation,p_actor,p_base,p_operation);
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  select * into v_head from public.zentra_workspaces where organization_id=p_organization for update;
  if not found then raise exception using errcode='PA105',message='Publication workspace not found'; end if;
  if not exists(select 1 from public.zentra_action_publication_guards where organization_id=p_organization) then
    raise exception using errcode='PA106',message='Publication coordination has not been enabled';
  end if;
  select * into v_operation from public.zentra_action_publication_operations where operation_id=p_operation for update;
  if found then
    if row(v_operation.organization_id,v_operation.snapshot_id,v_operation.installation_id,v_operation.actor_id,v_operation.base_revision)
      is distinct from row(p_organization,p_snapshot,p_installation,p_actor,p_base) then
      raise exception using errcode='PA107',message='Publication operation identity mismatch';
    end if;
    if v_operation.state='committed' then
      return jsonb_build_object('committed',true,'revision',v_operation.publication_revision,'snapshotId',v_operation.snapshot_id);
    end if;
    if v_operation.state='cancelled' then
      return jsonb_build_object('committed',false,'revision',v_operation.result_revision,'snapshotId',v_operation.result_snapshot_id);
    end if;
  end if;
  select * into v_candidate from public.zentra_workspace_snapshots where organization_id=p_organization and id=p_snapshot for update;
  if found and row(v_candidate.installation_id,v_candidate.created_by,v_candidate.base_revision)
    is distinct from row(p_installation,p_actor,p_base) then
    raise exception using errcode='PA107',message='Publication candidate identity mismatch';
  end if;
  if v_candidate.revision is not null then
    if v_operation.operation_id is null then
      insert into public.zentra_action_publication_operations(operation_id,organization_id,snapshot_id,installation_id,actor_id,base_revision,state,publication_revision,result_revision,result_snapshot_id,
        candidate_manifest,candidate_size_bytes,candidate_content_version,closed_at)
        values(p_operation,p_organization,p_snapshot,p_installation,p_actor,p_base,'committed',v_candidate.revision,v_candidate.revision,p_snapshot,
          v_candidate.manifest,v_candidate.size_bytes,v_candidate.content_version,now());
    else
      update public.zentra_action_publication_operations set state='committed',publication_revision=v_candidate.revision,
        result_revision=v_candidate.revision,result_snapshot_id=p_snapshot,closed_at=now() where operation_id=p_operation;
    end if;
    return jsonb_build_object('committed',true,'revision',v_candidate.revision,'snapshotId',p_snapshot);
  end if;
  -- Even an absent/pruned candidate gets a permanent tombstone from the private
  -- server identity. A delayed RPC with this operation can never advance a head.
  if v_operation.operation_id is null then
    insert into public.zentra_action_publication_operations(operation_id,organization_id,snapshot_id,installation_id,actor_id,base_revision,state,result_revision,result_snapshot_id,
      candidate_manifest,candidate_size_bytes,candidate_content_version,closed_at)
      values(p_operation,p_organization,p_snapshot,p_installation,p_actor,p_base,'cancelled',v_head.revision,v_head.snapshot_id,
        v_candidate.manifest,v_candidate.size_bytes,v_candidate.content_version,now());
  else
    update public.zentra_action_publication_operations set state='cancelled',result_revision=v_head.revision,
      result_snapshot_id=v_head.snapshot_id,closed_at=now() where operation_id=p_operation;
  end if;
  return jsonb_build_object('committed',false,'revision',v_head.revision,'snapshotId',v_head.snapshot_id);
end $$;

create function public.zentra_action_publication_fact_v1(p_organization text,p_operation uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_operation public.zentra_action_publication_operations%rowtype;
begin
  if p_organization is null or length(p_organization) not between 1 and 160 or p_organization~'[[:cntrl:]]' or p_operation is null then
    raise exception using errcode='PA104',message='Invalid publication identity';
  end if;
  perform public.zentra_assert_legacy_workspace_writable_v1(p_organization);
  select * into v_operation from public.zentra_action_publication_operations
    where operation_id=p_operation and organization_id=p_organization;
  if not found then return null; end if;
  return jsonb_build_object('operationId',v_operation.operation_id,'organizationId',v_operation.organization_id,
    'snapshotId',v_operation.snapshot_id,'installationId',v_operation.installation_id,'userId',v_operation.actor_id,
    'baseRevision',v_operation.base_revision,'state',v_operation.state,'manifest',v_operation.candidate_manifest,
    'sizeBytes',v_operation.candidate_size_bytes,'contentVersion',v_operation.candidate_content_version,
    'result',case when v_operation.state='pending' then null else jsonb_build_object('committed',v_operation.state='committed',
      'revision',v_operation.result_revision,'snapshotId',v_operation.result_snapshot_id) end);
end $$;

revoke all on function zentra_admission_private.action_publication_immutable_v1(),
  zentra_admission_private.action_publication_write_guard_v1(),
  zentra_admission_private.assert_action_publication_identity_v1(text,uuid,text,text,bigint,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.zentra_enable_action_publication_guard_v1(text),
  public.zentra_commit_workspace_v2(text,uuid,text,text,bigint,uuid),
  public.zentra_close_action_publication_v1(text,uuid,text,text,bigint,uuid),
  public.zentra_action_publication_fact_v1(text,uuid)
  from public,anon,authenticated;
grant execute on function public.zentra_enable_action_publication_guard_v1(text),
  public.zentra_commit_workspace_v2(text,uuid,text,text,bigint,uuid),
  public.zentra_close_action_publication_v1(text,uuid,text,text,bigint,uuid),
  public.zentra_action_publication_fact_v1(text,uuid) to service_role;
comment on table public.zentra_action_publication_guards is 'Opt-in permanent CH publication protocol guard. Empty after migration; requires coordinated D1 gateway rollout before enabling.';
comment on table public.zentra_action_publication_operations is 'Permanent server publication receipts/tombstones, not business permissions, D1 atomicity, native execution or content/SQLite corroboration.';
comment on function public.zentra_close_action_publication_v1(text,uuid,text,text,bigint,uuid) is 'Serializes with late commit under the same head lock. Close never publishes; committed receipts survive transport pruning. No TTL or release of terminal operation identity.';
commit;
