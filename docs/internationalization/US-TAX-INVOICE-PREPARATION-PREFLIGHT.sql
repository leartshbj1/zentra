-- Proposed read-only staging/production preflight. NOT executed on a hosted DB.
-- Run only after explicit deployment approval, with authorized private access.
-- No customer document, identity, credential, address or account ID is projected.
-- PREREQUISITE: run US-STAGING-STRUCTURE-PREFLIGHT.sql first and verify that
-- zentra_us_tax_operations and its reviewed dependency chain actually exist.
-- The subsequent structural audit found them absent on the current hosted DB;
-- this operation-count proposal has NOT been run there and is not a bootstrap.
begin read only;

-- Newly protected mutations require durable reviewed-input links. A pre-existing
-- uncommitted observed operation must be reconciled before applying the new
-- migration; do not fabricate a human review, retarget it or delete its evidence.
select status, count(*) as observed_test_operations
from public.zentra_us_tax_operations
where resolved->'binding'->>'evidenceKind' = 'provider_observation'
group by status
order by status;

select count(*) as uncommitted_observed_operations_requiring_review
from public.zentra_us_tax_operations
where resolved->'binding'->>'evidenceKind' = 'provider_observation'
  and status <> 'committed';

-- Check actual deployed migration history separately against the reviewed
-- dependency chain. Do not rewrite history or apply a schema downgrade.
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 12;

rollback;
