-- Record the authorized US launch offer without changing Swiss licensing.
-- Existing applications stay unversioned; only new submissions get this offer.
alter table public.us_pilot_leads add column offer_version text;
alter table public.us_pilot_leads alter column offer_version set default 'us-pilot-free-month-v1';
alter table public.us_pilot_leads add constraint us_pilot_leads_offer_version_check check (offer_version is null or offer_version = 'us-pilot-free-month-v1');
comment on column public.us_pilot_leads.offer_version is 'One free calendar month from US pilot access activation; no card, commitment, auto-renewal or automatic charge. Recorded offer only, not an account or license entitlement.';
