begin;

-- Migration corrective pour les projets ayant deja applique 00100. La date de
-- conservation et les empreintes de chaine restent intactes : la fin
-- d'exercice historique est reconstruite a partir de retention_until.
alter table public.invoice_archives
  add column if not exists fiscal_year_end date;

-- Le garde d'immuabilite bloque volontairement toute modification applicative.
-- La desactivation reste bornee a cette transaction de migration, qui prend le
-- verrou de table necessaire et est entierement annulee en cas d'erreur.
alter table public.invoice_archives
  disable trigger invoice_archives_immutable_update_guard;

update public.invoice_archives
set fiscal_year_end = (retention_until - interval '10 years')::date
where fiscal_year_end is null;

alter table public.invoice_archives
  enable trigger invoice_archives_immutable_update_guard;

do $$
begin
  if exists (
    select 1
    from public.invoice_archives
    where fiscal_year_end is null
      or fiscal_year_end < issue_date
      or fiscal_year_end > (issue_date + interval '18 months')::date
      or retention_until <> (fiscal_year_end + interval '10 years')::date
  ) then
    raise exception
      'invoice archive retention cannot be reconciled automatically; verify the fiscal year end before retrying'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.invoice_archives
  alter column fiscal_year_end set not null;

alter table public.invoice_archives
  drop constraint if exists invoice_archives_retention_minimum;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.invoice_archives'::regclass
      and conname = 'invoice_archives_fiscal_year_end'
  ) then
    alter table public.invoice_archives
      add constraint invoice_archives_fiscal_year_end check (
        fiscal_year_end >= issue_date
        and fiscal_year_end <= (issue_date + interval '18 months')::date
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.invoice_archives'::regclass
      and conname = 'invoice_archives_retention_exact'
  ) then
    alter table public.invoice_archives
      add constraint invoice_archives_retention_exact check (
        retention_until = (fiscal_year_end + interval '10 years')::date
      ) not valid;
  end if;
end;
$$;

alter table public.invoice_archives
  validate constraint invoice_archives_fiscal_year_end;
alter table public.invoice_archives
  validate constraint invoice_archives_retention_exact;

comment on column public.invoice_archives.fiscal_year_end is
  'Fin de l exercice comptable; retention_until est exactement dix annees civiles plus tard.';

commit;
