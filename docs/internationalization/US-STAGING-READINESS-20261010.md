# Zentra US — staging readiness and structural reconciliation

10 October 2026, Europe/Zurich. Source base: `24a8f6f`, following invoice preparation source `f5f8ac83b9bfc2404b0e5c4125b5a5cf7ef12392`. This is a read-only hosted audit and a local migration-chain rehearsal. It is not permission to deploy, enable gates or move production data.

## What is actually deployed

Supabase metadata on 9 October UTC (10 October Europe/Zurich), starting at 23:20 UTC, identifies project `xvfohjdlhlirksrvkiqu` as **ACTIVE_HEALTHY**, region **eu-central-2**, PostgreSQL **17.6.1.166**, engine 17. No customer rows, keys, emails, financial documents or saved credentials were read. Region metadata does not establish a certification or legal residency guarantee. The final observation time is in the evidence inventory.

The seven recorded migrations are `20261004150344`, `20261004171300`, `20261005002340`, `20261006114402`, `20261006155425`, `20261007165615` and `20261007173315`. Earlier CH objects exist despite their migrations not appearing in that recorded history. **Do not replay a baseline or run `db push` over the whole folder because its version is missing.**

The seven required legacy tables are present: company profiles, workspaces, snapshots, chunks, number reservations, content parts and content blobs. All have RLS enabled, owner `postgres`, and table ACLs for `postgres`/`service_role`, without anon/authenticated entries. Snapshot columns include `content_version` and `content_digest`. The inventory records column types/nullability and PK/FK/CHECK definitions; this is structural evidence, not an end-to-end hosted CH test.

The five legacy RPCs are present with the expected argument signatures and `jsonb` results. All are currently `SECURITY DEFINER`, owner `postgres`, empty search path, and execution ACLs limited to `postgres`/`service_role`: commit workspace, reserve numbers, prepare content, reserve blob and claim cleanup. Read-only function-body metadata matches the versioned baseline; their deployed bodies use CRLF line endings. The portable local assertion canonicalizes only line endings to that observed encoding, with the five deployed body hashes unchanged. Definition/body hashes are recorded. The new admission role/schema are absent. Seven platform event triggers exist, including enabled `ensure_rls`; its actual `rls_auto_enable()` body and restricted execution ACL were inventoried separately.

The country, ERP, fiscal-operation tables and US functions checked in the initial metadata query are absent. The reusable structural preflight inventories all 33 expected international tables without assuming they exist. The new US code's local tests therefore do **not** describe a deployed US ERP.

Hosted D1 migration state, R2 resources, Worker secrets/flags, Stripe sandbox objects and native application deployment were **not** inspected or changed in this audit. Source names such as `DB`/`FILES` do not prove separate hosted resources.

## Reviewed Supabase migration chain

Reuse the existing conforming legacy schema. Its relevant versioned source baseline is `202609140200_company_collaboration.sql` plus `202609200300_company_content.sql`; company profiles remain independent and preserved. Platform/archive/mail/PostFinance/pilot migrations are not international SQL prerequisites and must not be replayed as a shortcut.

The pending international chain contains 19 unchanged files, in this exact order:

1. `20261007194528_international_workspace_country_config.sql`
2. `20261007222349_international_us_erp_persistence.sql`
3. `20261007224820_international_us_erp_delta_stream.sql`
4. `20261007225725_international_us_erp_seller_snapshot.sql`
5. `20261008001726_new_us_workspace_admission.sql`
6. `20261008013200_international_tax_proof_allowlist.sql`
7. `20261008034422_international_us_seller_profile.sql`
8. `20261008044402_international_us_tax_profile.sql`
9. `20261008060826_international_us_tax_operations.sql`
10. `20261008081825_international_us_purchasing_v2.sql`
11. `20261008105120_international_us_projects_v3.sql`
12. `20261008161118_international_us_journal_periods_v4.sql`
13. `20261008172520_international_us_tax_invoice_capability_v2.sql`
14. `20261008184605_international_us_bank_reconciliation.sql`
15. `20261008194930_international_us_supplier_proposals.sql`
16. `20261008210008_international_us_automation_analysis.sql`
17. `20261009215104_international_us_workspace_sync_heads.sql`
18. `20261009222319_international_us_tax_test_merchant.sql`
19. `20261009224607_international_us_tax_invoice_preparation.sql`

Country → ERP/stream → seller/tax facts → fiscal operations → purchasing/projects/accounting v4 → tax capability is an ordered dependency. Bank/supplier/analysis precede compact sync heads. Merchant and invoice preparation come last. Several functions/constraints are intentionally replaced by later versions; sorting or omitting these migrations changes the contract.

## CH impact and data preservation

No international migration backfills a CH country, converts a workspace, copies its profile, renumbers invoices or rewrites the CH ledger. Country uncertainty remains explicit. Nevertheless, the admission migration **changes the CH execution path**: six legacy triggers and five public wrappers lock/check the workspace; the original five function bodies move into `zentra_admission_private`. Closed US flags do not bypass these database effects.

Before any approved apply, compare actual owners/ACLs/signatures and preserve the original function definitions. Rehearse calls under the actual effective roles, including the original `SECURITY DEFINER` bodies. Verify CH snapshots, content transfer, number allocation/replay and cleanup immediately after admission and after the full chain. A rollback of these wrappers needs a reviewed restoration procedure; disabling flags alone does not restore the old CH function layout.

US stream/sync-head baseline backfills are bounded to pre-existing US heads; they do not invent old events. Seller/proof `NOT VALID` constraints preserve old stored rows but can reject their next modification. Other v2/v3/v4 constraints validate immediately. If an older observed fiscal operation exists, its missing human confirmation must never be fabricated. Current metadata reports its table absent, not a count of zero customer operations.

## Isolated hosting and D1 prerequisites

First reconcile D1's existing `0000`–`0084` objects/history. Then use the unchanged raw SQL `0085` creation intents, `0086` legacy country guards, `0087` SaaS authorities, `0088` device admission, `0089` device capability v4 and `0090` team admission. The Drizzle journal does not cover the final raw SQL chain; blind generation/replay is unsafe. This audit does not claim those files are remotely installed.

The subsequent local SaaS milestone adds `0091_international_us_saas_test_checkout.sql`, generated through Wrangler. Reconcile and approve this additive purchase/session/proof extension too; it is not remotely applied. See `US-SAAS-TEST-PLAN-20261010.md` and its delivery for the current chain and checks.

The next local lifecycle milestone adds `0092_international_us_saas_test_lifecycle.sql`, also generated through Wrangler. It preserves the immutable initial admission and adds paid-period/observation history, the effective authority projection and updated Team/device guards. Reconcile the full ordered chain through 0092 before using the new readers: they deliberately have no missing-schema fallback. Neither 0091 nor 0092 is known to be remotely installed. See `US-SAAS-LIFECYCLE-TEST-DELIVERY-20261010.md` for its separate local validation and limits.

A build with neither `ZENTRA_BUILD_KIND` nor `ZENTRA_BUILD_PROFILE_FILE` chooses production. A staging build must use the validated **sandbox** profile, its own origins/verifier, dedicated D1/R2/Supabase resources, then the matching runtime tuple `ZENTRA_DEPLOYMENT_KIND`, `ZENTRA_DEPLOYMENT_PROFILE_ID`, `ZENTRA_DEPLOYMENT_PROFILE_SHA256`. The runtime origin/profile checks must pass. No production resource ID, founder shortcut, updater or customer dataset is a staging fixture. Provisioning or region changes need the user's separate approval.

Auth needs the staging Supabase origin, publishable Auth key, private server key, canonical HTTPS site origin and the exact `/api/auth/confirmation` redirect. Real users, refreshed/revoked sessions and two-device discovery must be tested. A browser-supplied role, licence token, CHF subscription or owner email is not an authority for a new US workspace.

## SaaS admission: observed gap and current local milestone

At the audit base `24a8f6f`, `workspace-creation-server.ts` called PostgreSQL admission, then projected `postgres_confirmed / us_subscription_required`; no runtime caller connected verified SaaS USD evidence to `prepareUsAuthorityAdmission()` and the D1 sink. This was an observed source gap, not an inference from a closed gate.

The subsequent local milestone now implements that **initial TEST-only** runtime in `us-saas-test-server.ts`, a dedicated Stripe gateway and atomic D1 sink. An authenticated four-language onboarding uses server-configured USD offers, a durable initial purchase, signed webhook/recovery and verified paid evidence before READY. Checkout redirects and metadata alone do not grant access. Production builds and missing/mismatched sandbox configuration remain closed. No provider call or hosted activation was exercised. A TEST Price/catalogue alone is still insufficient. Existing CH Checkout/webhooks are unchanged; no US production price is created.

The following **local TEST lifecycle** milestone now verifies renewal periods at the unchanged offer, preserves access through an already proven paid period on payment failure/cancellation, and terminally restricts access after confirmed refunds/disputes under a conservative pilot policy. Team, Automation and device checks use the same effective projection; existing credentials retain their own expiry. This is not hosted provider synchronization: missed events/reconciliation, plan changes, trials, discounts/prorations, SaaS taxes, non-card proof and commercial refund/dispute policy remain open. Both historical milestone reports retain their original scope rather than being relabelled as hosted or complete.

## Gates and remaining product boundaries

Keep all flags closed initially. Core/creation/ERP gates precede purchasing v2/projects v3/accounting v4 capability negotiation. Team, background sync, bank reconciliation and supplier mail have separate flags. Supplier analysis additionally requires its flag, budget policy, Automation rights, consent and an available provider. Native admission stays closed for this browser pilot.

Fiscal TEST needs the separate merchant/invoice gates, a dedicated restricted `rk_test_` credential per company, actual merchant observation, owner activation, seller/tax facts and immutable human preparation. The generic/live tax provider remains null. SaaS credentials must not become customer merchant credentials.

US documents currently cover exports from durable snapshots and bounded supplier **text**. They do not deliver original PDF/image upload, OCR, private original archives or a verified remote retention/restore flow. An existing `FILES` binding is not proof of those features. Support US mail intake, original documents, lifecycle completion and hosted scaling remain open.

## Read-only advisors

- **WARN:** leaked-password protection is disabled according to the hosted Auth advisor. Review and enable through an approved Auth configuration change; none was made here. [Password security guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- **INFO:** 73 RLS-enabled relations have no policies, including server-only/recovery relations. Do not add broad client policies merely to silence the notice. [RLS policy diagnostic](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
- **INFO:** 12 unindexed foreign keys: ten on public device authorizations, invoice archives, organization domains/invitations/members and audit events; two on migration identity links. Confirm real query/delete/update plans before proposing indexes. [Foreign-key indexes](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).
- **INFO:** 52 relations lack primary keys, primarily recovery copies; 15 indexes are reported unused. Do not rewrite recovery history or remove indexes from a usage snapshot. [Primary keys](https://supabase.com/docs/guides/database/database-linter?lint=0004_no_primary_key), [unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).
- **INFO:** Auth uses an absolute connection allocation of ten. Review its percentage strategy with instance scaling; this observation is not a measured bottleneck or a 150-company capacity test. [Production checklist](https://supabase.com/docs/guides/deployment/going-into-prod).

## Deployment sequence and rollback

1. Run the **structural** preflight and reconcile actual migration histories/objects, immutable source hashes, owners/grants and platform event triggers. Capture an approved, verified recovery point. Do not copy real customer data to demos.
2. Repeat the whole chain on an isolated PG17.6 staging with synthetic CH/US data and the real baseline/effective rights. `supabase/config.toml` still declares PG15, so an unchanged CLI reset does not reproduce the hosted engine. The RAM chain test complements, but does not replace, hosted platform validation.
3. Check CH function compatibility at admission and at chain end, then all 33 international relations, constraints, private grants/RLS and publications. Stop on a mismatch; reconcile partially applied objects instead of blindly rerunning SQL.
4. Only once fiscal-operation dependencies exist, run `US-TAX-INVOICE-PREPARATION-PREFLIGHT.sql`. That earlier proposal directly references `zentra_us_tax_operations` and would fail on today's absent table. It was **not** executed here. Reconcile older uncommitted observations rather than inventing human review.
5. Validate the now locally implemented initial USD SaaS admission and lifecycle with actual Auth + workerd D1 + PostgreSQL and dedicated Stripe sandbox proofs. Exercise new intent → ready → ERP → merchant TEST → review → issue → exact replay, stale inputs, lost responses and two-user propagation. Separately exercise renewal, failed payment, cancellation, refunds/disputes and retained/expired device credentials before any commercial opening; local tests do not establish those hosted transitions. Register and verify the lifecycle webhook, approve its policy and reconcile undelivered events before opening gates.
6. Open only explicitly approved TEST gates after those proofs. No live tax, real invoices, production price mutation, publication or native release is implied.

For an issuance-only rollback, close the **TEST invoice/merchant** gates first and retain compatible historical receipt reads with Core/ERP, Auth, current rights and readers still available. Closing Core or ERP stops dispatch before receipt recovery: stored history remains preserved, but that access becomes temporarily unavailable. A broader security incident may require this stricter shutdown; do not promise reads in that state. Keep journals, preparations, audit data and applied migration history. Restore legacy wrappers only through the separately reviewed procedure and recovery point. Never drop international tables, erase operations or rewrite earlier migrations as an automatic rollback.

See `US-STAGING-DELIVERY-20261010.md` and `docs/evidence/us-staging-readiness-20261010.json` for the exact executed checks and remaining limitations. The full ERP US objective remains active.
