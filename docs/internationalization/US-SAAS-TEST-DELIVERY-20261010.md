# US SaaS initial TEST activation — delivery

10 October 2026, Europe/Zurich. Source base `d3a92e036aa7c102b3e6cd65e50ec69c60869345`, branch `codex/international-runtime`. This milestone implements the previously missing runtime between a PostgreSQL-confirmed US workspace and its initial paid USD TEST authority. It is local source and validation, **not a US commercial launch or hosted activation**. The complete international ERP objective remains active.

## 1. Changes

A separate authenticated onboarding creates a US/USD company, requires explicit address/state/ZIP/time-zone/accounting-basis choices, shows server-approved TEST offers and resumes the saved preparation. Existing workspaces and CH subscriptions are not converted. The entry and API remain absent unless a validated sandbox build/runtime, dedicated credentials, catalogue and all three gates agree.

An immutable purchase is reserved before external Checkout creation. Its persisted IDs, receipt/configuration, approved offer, seats, provider account, origin, parameters and one-hour expiration are reused after uncertain responses. A closed page can explicitly reopen the same pending Checkout; reloading or returning from Checkout never starts a purchase or grants rights. The browser saves only an opaque request UUID in session storage; submitted company envelopes remain in RAM during uncertainty and are purged on account/access change.

The dedicated gateway verifies TEST account/objects, exact USD Price/Product, quantity, initial subscription invoice, paid period and the linked Invoice Payment → PaymentIntent → captured card Charge. Unpaid, partial, discounted, taxed, credited, refunded, disputed, off-Stripe, foreign and ambiguous evidence is refused. Signed webhooks only locate an already bound purchase; the full provider graph is reread before admission. Browser recovery uses the same proof boundary. Identity/configuration are checked again around awaits, including provider-error paths.

D1 commits the paid proof, own subscription authority, owner membership and READY transition together. A replay preserves the first proof/provenance and cannot re-admit a revoked authority. SQL prevents a new TEST purchase from using the old sink without its proof. Existing historical private admissions without a new purchase retain their prior contract.

## 2. Created files

- `lib/international/us-saas-test-{contract,public,server,bindings,stripe,d1}.ts` and the corresponding server/bindings/stripe/D1 tests: strict DTOs, isolated bindings, HTTP handlers, gateway, persistence and refusal/recovery coverage.
- `drizzle/0091_international_us_saas_test_checkout.sql`: additive purchase/session/paid-proof history and guards.
- `app/api/international/billing/test/route.ts`, `recover/route.ts`, `webhook/route.ts`: dedicated dynamic routes.
- `app/compte/espaces/us/nouveau/page.tsx`, `components/account/us-test-onboarding.tsx` and `.css`: sandbox-only account entry and responsive form.
- `lib/international/browser-us-test-onboarding.ts`, its test, `us-test-onboarding-copy.ts`, `us-test-onboarding.test-fixtures.ts`, page/UI/browser tests and `tests/us-test-onboarding-preview.{html,tsx}`: FR/EN/DE/IT transport, copy, synthetic preview and actual React checks.
- `US-SAAS-TEST-PLAN-20261010.md`, this delivery and `docs/evidence/us-saas-test-20261010.json`: configuration, approved-staging sequence, risks and exact source/report inventory.

The evidence inventory gives the authoritative complete list and hashes. Preview data and prices are explicitly fictitious; no real provider key, Price ID or customer payload is a fixture.

## 3. Modified files

- `saas-authority-d1.ts`: optional private TEST binding/proof in the existing atomic sink, exact replay and revoked-authority refusal.
- `saas-authority.test.ts`: regression expectations for terminal revocation and deterministic database-clock fixtures.
- `workspace-creation-server.ts` and its review test: optional expected-actor fence prevents an unnoticed browser-account switch from writing as another actor.
- `app/compte/espaces/page.tsx` and `components/account/workspace-picker.tsx`: gated, localized US TEST entry.
- `STATUS-20261009.md` and `US-STAGING-READINESS-20261010.md`: distinguish the original observed runtime gap from the now implemented initial-payment milestone and add D1 0091.

The CH Checkout, Stripe client/webhook, old migrations, prices and native checkouts are preserved. No mass file move or independent second application is introduced.

## 4. Migrations and rollback

Wrangler generated the new local additive D1 migration 0091. The executed SQL validation loads actual versioned D1 SQL through 0091 in Node SQLite, with foreign keys enabled. No PostgreSQL migration changes in this milestone and no SQL is applied remotely. Hosted D1/Supabase histories and effective rights must first be reconciled and the target migration explicitly approved; the earlier audit found no international PG tables deployed and an incomplete recorded CH migration baseline.

For rollback close the dedicated SaaS TEST gate, retain purchase/session/proof/authority/member/PG receipt histories and compatible readers. Closing this gate also stops its recovery/webhook routes; it does not revoke all already admitted authorities. A rollback to code that ignores 0091 is unsafe for new purchases. Do not delete evidence, reset a terminal revocation, create a replacement purchase after uncertainty, rewrite old SQL or change CH wrappers as an automatic rollback. The plan details the separate Auth/ERP/fiscal gates and approved recovery procedure.

## 5. Executed checks

**493/493 selected tests pass**: 492 unit/service/SQL/render/page/regression tests across 18 files, plus one explicit actual-React browser test. Final reports have zero failed suites/tests and zero skipped/pending/todo tests. Counts, report hashes and exit codes are recorded in the evidence manifest. This includes 82 gateway tests, 46 D1 tests and 46 focused browser-transport/render/page tests; these counts are subsets, not additional totals. Existing US creation/authority/device/team and CH Stripe webhook/Checkout regressions are included. D1 tests execute real SQLite constraints and compose the actual HTTP handlers with that store; Auth, PG confirmation and provider proof inputs in that composition are explicit trusted TEST fixtures.

The gateway test uses the **installed Stripe SDK 22.6.0 with a local simulated fetch transport**, not only plain objects. It discovered and now covers real SDK decimal hydration on Price, Subscription, Checkout lines and Invoice pricing/quantity. Only exact frozen SDK Decimal values in four known field names are normalized, then the usual bounded JSON/proof validation applies. No provider request was sent.

The actual React browser test exercises lost creation/Checkout responses, exact envelope retries, unpaid refusal, explicit recovery, pending reopening, expired/returned/reserved states, opaque storage, Auth purge, keyboard order and invalid-field focus. It checks offers/pending/ready across four languages and light/dark at 320px with 200% root text. Ten screenshots — eight mobile offers and two desktop creation — were opened for visual inspection. No horizontal overflow or inaccessible tested action was found. Browser data/API are synthetic in-memory fixtures, distinct from the separate HTTP/SQL test. The first browser run failed because the test's exact label included newly rendered field-error text; its locator was corrected without changing application behavior. The later rerun updates Vite's deprecated build-option spelling only.

Global TypeScript, scoped type-aware lint across all changed TS/TSX files, brand checks and default **production-profile** build pass. Build output retains existing middleware-deprecation/static-route-classification notices. The new feature remains closed in that profile. Earlier failing reports are retained separately: SQL prefix length, CH fixture subscription uniqueness, revoked-authority expectation, browser locator, lint method annotations/deprecated option and one combined-suite authority-admission failure not reproduced in the targeted run. The fixture's database/JavaScript clocks are now aligned and the rejection of an ahead timestamp is explicitly checked; this is not proof of the original failure's precise cause or of hosted clock synchronization. None of the earlier reports is relabelled as passing. No hosted Auth/PG/workerd-D1/Stripe/two-device/load/restore/native test is claimed, and no full CH QR/TVA/native regression suite was rerun here.

## 6. Risks

Initial activation is TEST-only, without SaaS tax or trials, and accepts an integral captured card payment only. Dynamic Checkout can expose another payment method; that does not make its evidence supported. A real isolated sandbox must validate actual account permissions, signatures/events, object shapes and end-to-end timing before activation. SDK normalization is intentionally pinned to 22.6; upgrading requires replaying the real-SDK transport test. Twenty seconds per provider call does not bound the total verification time; the browser can time out while the server completes, so recovery remains necessary.

Late recovery reads at most 100 sessions in the saved window and fails closed on truncation/ambiguity. An expired or unlocatable attempt has no automatic replacement/abandonment workflow. Invoice renewals cannot extend the immutable initial 0087 authority. Plan changes, cancellation, refund/dispute handling and automatic provider-revocation propagation are unfinished. A failed recovery of a later-invalid payment is not a permanent Stripe-rights synchronizer. Do not open commercially on the strength of the initial proof alone.

Node SQLite does not establish workerd D1 concurrency/transactions or hosted composition. Browser emulation is not an iPhone/native test or a user study. Existing CH source protection and targeted regressions are not proof that every CH function has been retested. No legal/accounting certification, tax compliance, measured savings or 150-company capacity is asserted.

## 7. Completed

The initial USD TEST payment-to-READY runtime, atomic persistence, scoped browser onboarding, explicit exact recovery and localized interface are implemented and locally validated. No hosted flag, resource, region, customer data, subscription, secret, public site or native artifact was changed in this milestone. The separately published CH site and native source heads remain preserved.

## 8. Experimental and next

Run the approved isolated staging sequence in `US-SAAS-TEST-PLAN-20261010.md`, with reconciled migrations and actual Auth/D1/PG/dedicated Stripe sandbox; then validate two real identities, revocation, lost responses and rights. Develop a versioned recurring-subscription lifecycle separately. The full US ERP still needs its commercial sales lifecycle, original-document intake/archives, Support/Automation workflows, customer payments, professional tax/accounting/legal validation and hosted/native pilot. This milestone completes none of those by implication.
