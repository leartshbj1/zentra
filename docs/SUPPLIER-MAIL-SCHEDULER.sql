-- Product scheduler: Supabase calls only Zentra's due-mailbox endpoint.
-- Provision zentra_support_mail_sync in Vault through an administrator first.
-- No access to documents, account management or other API routes is granted.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists zentra_internal;
revoke all on schema zentra_internal from public, anon, authenticated;
create or replace function zentra_internal.sync_support_mail()
returns bigint language plpgsql security definer set search_path = '' as $$
declare token text; request_id bigint;
begin
  select decrypted_secret into token from vault.decrypted_secrets
  where name = 'zentra_support_mail_sync';
  if token is null then raise exception 'Mail scheduler credential is missing'; end if;
  select net.http_post(
    url := 'https://zentraapp.ch/api/support/mail-sync',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) into request_id;
  return request_id;
end;
$$;
revoke all on function zentra_internal.sync_support_mail() from public, anon, authenticated;

-- Same name updates the existing schedule rather than creating a duplicate.
select cron.schedule('zentra-support-mail','* * * * *',
  'select zentra_internal.sync_support_mail()');

-- Read-only verification after a scheduled invocation:
-- select jobname, active, schedule from cron.job where jobname='zentra-support-mail';
-- select status_code,timed_out,error_msg,created from net._http_response order by id desc limit 3;
