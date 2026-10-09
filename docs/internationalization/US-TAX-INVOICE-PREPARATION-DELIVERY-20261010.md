# US invoice preparation — local TEST delivery

Base: `9b0d4b66f446eef12377748ca1e5af136cd6b95e`. Plan: `US-TAX-INVOICE-PREPARATION-PLAN-20261010.md`. This is an incremental private TEST milestone, not a production US release or a compliance certification.

## 1. Changes

An immutable human preparation binds the exact existing ERP request, organization and actual financial actor to the accepted estimate, confirmed actual catalogue identifiers, explicit invoice instant/destination, country/seller/tax facts and admitted merchant. The shared ERP command, resolved tax proof and provider idempotency contracts remain unchanged. New protected SQL transitions compare these inputs before accepting a calculation or committing the existing invoice and balanced ledger operation.

An independent review found that a declared command hash alone did not prove the committed due/accounting dates and period. The new common transition/completion guard now compares the actual invoice and accrual journal effects with the reviewed command; the legacy v2 mutation path is protected too. Regression cases require a full rollback of coherently forged effects and retain the original exact commit/replay.

The runtime hook is lazy. A committed ERP/operation receipt is historical and can be recovered before looking up today's merchant, preparation, catalogue or new-operation TEST gate. New work requires both the dedicated merchant gate and `INTERNATIONAL_US_TAX_TEST_INVOICE_ENABLED`, in addition to Core/ERP. All defaults remain false. The generic/live provider remains null and SaaS subscription credentials are not used.

The translated browser panel reviews a checked service per line, company-zone local time, destination source and civil/accounting dates. DST gaps are rejected and repeated times expose both offsets. Uncertain writes keep their original bodies; recovery asks the exact ERP request first, and only a missing preparation triggers its exact confirmation request. Access loss purges the private tab state. The workbench coordinates writes and background reads rather than running competing operations.

Review collapses the editor and moves focus to the confirmation. Back preserves choices, reopens the editor and focuses its first field. The shared write revalidation now gives actual 401/402/403 access loss priority over simultaneous private configuration, capability or flag errors. Successful requests retain the previous number of Auth reads.

## 2. Created files

- Preparation contract/store, protected operation-store adapter and additive migration.
- Preparation/catalogue HTTP service, scoped TEST runtime composition and explicit invoice-time helper.
- Browser session/projection/copy helpers, TEST panel/styles and focused tests.
- Route wrappers for `tax-invoice-preparation` and `tax-catalogue`.
- Plan, this delivery, read-only hosted preflight proposal and final evidence inventory.

The final evidence file lists every path and hash; it is the authoritative inventory.

## 3. Modified files

- Runtime bindings/default environment example, US workspace page and binding tests.
- Existing issuer bounded-error projection/comment and regression tests.
- Shared runtime revalidation and a new focused regression file.
- Gateway/resolver catalogue port and their tests.
- US workbench write/background coordination and old invoice-editor visibility.
- Three established PostgreSQL suites now run through the new additive migration.
- International status document.

CH business paths, Stripe SaaS products/prices/subscriptions and earlier migration files are not rewritten by this phase.

## 4. Proposed migration and rollback

`supabase/migrations/20261009224607_international_us_tax_invoice_preparation.sql` was created with the Supabase CLI and is additive: immutable private preparations, immutable operation links, integrity/transition guards and protected RPCs, RLS and server-only grants. No hosted apply is performed.

Before an explicitly approved staging/production apply, run `US-TAX-INVOICE-PREPARATION-PREFLIGHT.sql` and reconcile any older uncommitted observed operations. Never fabricate their missing human review. Historical committed receipts remain readable. Preserve the deployed dependency chain and take the deployment's verified recovery snapshot.

Rollback begins by disabling new TEST issuance. Do not delete preparations, operations, invoices or journals. Keep compatible receipt reads and audit history. Removing stored evidence or changing existing migrations is not an automatic rollback and would require separate review/approval.

## 5. Executed validation

- **1,981/1,981** targeted unit/service/transport/regression tests in 42 files. Includes the changed sources, issuer and merchant boundaries, exact money/country/document behavior, CH cash-VAT/money, existing Stripe subscriptions/webhooks/Auth and Support/Automation regressions.
- **170/170** actual local PostgreSQL assertions in 4 files: operations 122, invoice 20, merchant 12, preparation 16. The three established suites run through the new migration. New cases exercise real SQL guards, RLS/grants, immutability, stale inputs, coherent effect forgery, full rollback, exact replay, merchant expiry and unchanged CH snapshots.
- **1/1** complete browser workflow: actual React, HTTP preparation serializer/handler, ERP engine and deltas with explicitly synthetic Auth/private context/catalogue/tax/RAM ports. Covers immediate invoice visibility, held preparation/write locks, ERP-first exact retry while preparation is closed, paused sync while outcome is uncertain, access purge, role restrictions, DST gap/fold and review/Back focus. Eight mobile FR/EN/DE/IT light/dark captures at 375 px have no horizontal overflow; two desktop captures complete the visual proof. This is Edge desktop emulation, not a native device or private-provider sandbox run.
- **2,152** distinct executed tests total, **47** files, **0** failed tests/suites and **0** skipped/pending tests in those final reports. These are targeted results, not a passing claim for the entire repository suite.
- Global TypeScript passes. Scoped non-type-aware Oxlint correctness checks pass on 35 changed/new TS/TSX files. Brand verification and the production Vinext build pass. A final client-bundle scan is recorded in the evidence inventory.

Earlier SQL, browser-fixture, TypeScript-test-typing and lint failures and their repairs are retained separately under `.qa/us-tax-invoice-preparation` and `.qa/us-tax-invoice`; they are not counted as passing final tests. In particular, the original full Team suite workerd Windows failures remain failures. No injected provider response constitutes a real sandbox call.

## 6. Risks and limits

- The binding admission lifetime remains at most 120 seconds; the provider-key retry ceiling does not extend it. Changed/expired uncommitted inputs must not be silently retargeted. After any ERP attempt, an arbitrary 409 is not proof that no concurrent commit occurred. The browser retains the exact pending request; a future safe abandon flow needs authoritative outcome reconciliation.
- The catalogue proves technical identifier existence, not service applicability or legal obligations. The user confirms applicability. No code/rate is inferred or copied from an example. Codes requiring performance-location inputs are excluded from this narrow flow; unknown requirement shapes fail closed.
- The supported pilot is USD, exclusive taxable services, positive integral quantities and US destinations. Goods, exemptions, inclusive pricing, nexus determinations, live tax transactions/filing, payments, cash/accrual professional review and the broader commercial lifecycle remain separate work.
- Actual network latency, restricted-key permissions, merchant/registration setup, hosted Auth/D1/PG admission and two-device operation still need authorized staging/sandbox validation. Local bounds do not prove production performance or scalability.
- No migration, region move, live account call, hosted flag activation, native build/release or production publication is included.

## 7. Completed scope

The local opt-in TEST vertical is implemented and verified: immutable human inputs, protected preparation/operation SQL, actual lazy runtime wiring, bounded catalogue lookup, explicit company-zone time, translated responsive confirmation and exact recovery through the existing invoice/ledger engine. The due/accounting-date/period guards and actual access-loss priority defects found during review are corrected. Native and published-public checkouts remain clean at their preserved heads.

This milestone does not activate issuance, claim complete US ERP delivery or replace the remaining professional, hosted and real-provider validation.

## 8. Experimental / remaining

The entire new issuance path is opt-in TEST. It is not certified US GAAP, a legal nexus determination or a production tax service. The full international ERP goal remains active: hosted collaboration/pilot, complete US commercial cycle, real merchant/provider validation, US SaaS Checkout, customer payments and Support/Automation intake/originals remain outstanding as detailed in `STATUS-20261009.md`.

## Primary references reviewed

- [Stripe Tax Codes list](https://docs.stripe.com/api/tax_codes/list) and [retrieve](https://docs.stripe.com/api/tax_codes/retrieve): actual identifiers, bounded pagination and performance-location requirements. The installed SDK's typed object does not expose every newer documented requirement, so runtime validation checks it explicitly.
- [Standalone Tax API](https://docs.stripe.com/tax/standalone-tax-api), [calculation API](https://docs.stripe.com/api/tax/calculations/create) and [product tax codes](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior): explicit inputs and configured registrations; no universal US rate or inferred code.
- Existing merchant milestone references and Supabase INVOKER/RLS guidance remain applicable. These technical references do not replace professional legal/accounting validation.
