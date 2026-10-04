-- Records the migration applied to xvfohjdlhlirksrvkiqu by Supabase MCP.
-- Version 20261004150344 is the version returned by the remote migration history.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='rls_auto_enable'
      AND pg_get_function_identity_arguments(p.oid)=''
      AND p.prorettype='event_trigger'::regtype AND p.prosecdef
      AND md5(pg_get_functiondef(p.oid))='6998ea6b4c2480f5d2e34b5dcf3f8d36'
      AND EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtfoid=p.oid AND e.evtname='ensure_rls' AND e.evtenabled='O')
  ) THEN
    RAISE EXCEPTION 'RLS event trigger changed; privilege hardening aborted';
  END IF;
END
$guard$;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
