# US staging readiness — delivery

10 October 2026, Europe/Zurich. Base `24a8f6f`. This phase audits hosted **metadata in read-only transactions** and rehearses the full international migration chain in local RAM. It changes no hosted data, flags, subscriptions, resources or region. It does not deliver the still-missing SaaS USD payment-admission runtime.

## 1. Changes

The staging plan now reconciles actual PostgreSQL objects with the versioned chain instead of inferring schema absence from migration history. It distinguishes the healthy deployed CH schema from the locally tested, undeployed US extension. It identifies the material CH function-wrapper change, missing USD-to-ready runtime, D1/hosting prerequisites, document limitations and staged rollback conditions.

A structural preflight safely inventories missing tables without reading business rows or invoking RPCs. Independent review corrected its function coverage and added schema/role metadata. It covers all 33 international relations plus seven legacy relations and reports owners, ACLs, columns, constraints, policies, triggers, function hashes, admission-role attributes/memberships and publications. The older fiscal operation-count proposal now explicitly requires this structure/dependency check first.

A complete local PostgreSQL rehearsal applies the 19 unchanged international migrations together on the real versioned legacy baseline, with fictitious CH data populated beforehand. The five legacy function bodies are linked to the actual read-only deployed metadata hashes; only line endings are canonicalized to the observed CRLF encoding for portable checkouts. This complements the earlier fiscal suites, which did not combine bank, supplier, analysis, sync heads, merchant and preparation in one database. The observed `ensure_rls` function is reproduced as a dated fixture; the other six hosted platform triggers remain outside this rehearsal.

## 2. Created files

- `docs/internationalization/US-STAGING-READINESS-20261010.md`: concrete sequence, prerequisites, risks and rollback.
- `docs/internationalization/US-STAGING-STRUCTURE-PREFLIGHT.sql`: read-only catalogue inventory.
- `lib/international/international-staging-chain.postgres.test.ts`: full-chain RAM compatibility/security rehearsal.
- This delivery and `docs/evidence/us-staging-readiness-20261010.json`: exact provenance, file/report hashes and observed metadata summary.

The evidence inventory is the authoritative file list. Raw read-only metadata/advisor reports and local test outputs are retained under ignored `.qa/us-deployment-readonly` and `.qa/us-staging-chain`; no customer payload or credential is a fixture.

## 3. Modified files

- `US-TAX-INVOICE-PREPARATION-PREFLIGHT.sql` and its delivery now name the missing-table prerequisite and the subsequent audit. The earlier invoice milestone's execution history and test results are unchanged.
- `STATUS-20261009.md` records this milestone and the verified runtime admission gap.

No application runtime, CH business source, earlier migration, Price ID, subscription, private key or native checkout is modified by this phase.

## 4. Migrations and rollback

No new migration is created and none is applied remotely. The proposed sequence lists all 19 existing international SQL files with hashes. The seven recorded hosted migrations are not a complete history of CH object creation; missing versions must not trigger a blind baseline replay. D1's six international raw SQLs require separate reconciliation; their hosted state was not queried.

For issuance rollback, close the TEST merchant/invoice gates while retaining Core/ERP, Auth, current rights and compatible historical readers. Closing Core/ERP also blocks receipt dispatch, though data remains stored. Restoring the CH wrappers requires its own approved procedure; never delete US evidence or rewrite migration history as rollback. Production modifications, hosted staging provisioning or region changes still require the user's explicit approval.

## 5. Executed checks

**13/13 tests pass in one new file**, with zero failed tests/suites and zero skipped/pending/todo tests in the final report. Counts and report hashes are recorded in `docs/evidence/us-staging-readiness-20261010.json`. The full-chain test covers preservation after every migration; legacy functions/roles; actual five-RPC CH calls; private table access refusals; new US admission/replay/isolation; a real schema4 ERP initialization/replay/delta; and absence of private publication. The structural SQL is also executed locally before/after table installation and remotely in a read-only transaction.

Hosted observations confirm seven legacy relations with RLS, five restricted legacy RPCs, no private admission schema/role, **zero of the 33 expected international relations present**, no expected relation in the observed Realtime publications and healthy PostgreSQL 17.6. No inference is made about customer row counts. The leaked-password advisory and INFO findings are recorded rather than silently changed.

Global TypeScript `--noEmit` passes. Scoped non-type-aware Oxlint correctness checks pass on the new test. No production build/browser/native rerun is needed for this test/documentation-only phase; the last runtime source build remains the separately evidenced invoice milestone. The older global Team workerd failures are not relabelled as passing. The earlier wrong LF-only compatibility assertion failed once; decoded metadata confirmed the deployed CRLF bodies, and only the test's line-ending canonicalization was corrected. Its failing report is retained separately, without altering live hashes or migrations.

## 6. Risks

The PGlite rehearsal is a sequential RAM database with synthetic data, a storage-metadata stub and one reproduced platform trigger. It is not a hosted PG17.6, Auth, D1, R2, provider, two-device, restore or concurrency test. The current CLI config targets PG15; an approved hosted staging must match the actual engine and platform rights/triggers.

Source bindings do not prove remote isolation. Default builds choose production unless a validated sandbox profile is supplied. USD catalogue/Price configuration cannot substitute for the missing verified payment-to-admission runtime. Original US PDF/image archive/OCR and full commercial lifecycle remain incomplete. The advisor findings are configuration/performance leads, not proof of a data leak, measured outage or scaling capacity.

## 7. Completed

The deployment gap is documented from actual read-only metadata. The dependency order and CH-sensitive changes are explicit. The reusable structural preflight and complete-chain local rehearsal are delivered, with preserved source/report evidence and no hosted mutation. This is a readiness/compatibility milestone, not a production US launch.

## 8. Experimental and next

This phase activates no US gate; hosted Worker flag state remains unverified. Next: build and validate a separate, workspace-bound **SaaS USD TEST evidence → D1 READY** runtime, preserving existing CH billing. Then an explicitly approved isolated staging can exercise actual Auth/D1/PG/Stripe TEST, two users, revocation/recovery and load. Customer tax/live payments, professional accounting/legal validation, originals and remaining ERP workflows retain their own gates. The complete US ERP objective stays active.
