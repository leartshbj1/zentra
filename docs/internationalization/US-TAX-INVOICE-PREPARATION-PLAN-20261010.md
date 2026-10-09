# US invoice preparation — private TEST vertical

Base: `9b0d4b66f446eef12377748ca1e5af136cd6b95e`. This incremental phase follows the audited merchant-admission milestone. CH, SaaS billing, existing migrations and all hosted data remain unchanged.

## Outcome

Admit an explicitly reviewed US TEST invoice through the existing ERP engine. A preparation binds the actual financial actor, organization and exact existing `ErpRequest` to the accepted estimate, current country/seller/tax/merchant snapshots, individually confirmed actual catalogue codes, an explicit invoice instant and destination source. It is immutable; editing choices requires a new ERP idempotency key. No default or inferred tax code, rate, instant, address source, legal applicability or live issuance is introduced.

## Boundaries and sequence

1. Add a private typed preparation contract/store and additive versioned migration, created with the Supabase CLI. Preserve exact replay; reject a changed body under the same request key. Financial roles require current Management admission. Catalogue existence is evidence of existence only; users explicitly confirm taxable service applicability. Narrow existing scope: USD, positive integral quantities, exclusive taxable services and US destination. Other cases fail closed.
2. Link new observed TEST tax operations to the durable preparation. SQL must compare command identity, estimate/configuration snapshots and confirmed fiscal inputs under the established workspace/context/ERP lock order at reservation, recording and commit. Legacy RPCs must not bypass new-link protection; historical committed receipts stay replayable. Old fixture-only QA remains explicitly isolated.
3. Add bounded read-only real catalogue lookup and deterministic wall-time validation. Gaps fail; repeated local times require an explicit offset choice. The server uses the workspace IANA zone and verifies the selected instant, never a device-zone interpretation or an implicit midnight.
4. Add a same-origin, financial-role preparation endpoint with strict body/DTO, fresh Auth/D1 and merchant provenance around awaited phases. No private credential, account, tax facts, raw provider response or reusable grant reaches browser/logs.
5. Wire a lazy private TEST issuer behind an additional closed-by-default server flag. Historical receipt lookup precedes current merchant/preparation/catalogue reads. Reuse the established issuer, operation store, document and balanced ledger engine; keep generic/live tax provider null and SaaS payments separate.
6. Expose a translated, responsive TEST confirmation panel if the complete server capability is available. Preserve exact uncertain request retries and access-loss purging. A configuration/readiness label is informative, never issuance authority. Do not poll the provider in background.
7. Run targeted service/store/issuer/HTTP/browser tests and actual local PostgreSQL migration/guard tests, then TypeScript, scoped syntax checks and production build. Record executed counts and limitations; preserve clean native/public checkouts.

## Files / ownership

- Backend: new `lib/international/us-tax-invoice-preparation*.ts`, additive `supabase/migrations/*_international_us_tax_invoice_preparation.sql`, local PostgreSQL tests and protected operation-store integration.
- Service: new catalogue/preparation HTTP service and scoped TEST issuer composition, deterministic invoice time helper, focused tests; narrow gateway/resolver type changes if required.
- UI: new invoice preparation/session/copy/panel and scoped styles/tests; small existing sales workbench integration.
- Root: runtime/page/routes/flags integration, security review, regression/quality execution and evidence/delivery reports.

## Risks / release conditions

Primary risks: stale review, mixed snapshot, duplicate provider operation, replay blocked by rotated merchant, cross-tenant/role admission, unconfirmed code applicability and DST ambiguity. SQL and service tests must exercise these boundaries. No hosted migration, provider mutation, real merchant call, tax registration, production invoice, US price creation, native release or claim of legal/GAAP certification is authorized by this local phase. Deployment remains a separate explicit decision after staging validation. The broader US ERP objective remains active beyond this vertical.

The preparation captures the current merchant binding. Its existing admission lifetime is at most 120 seconds; the 23-hour provider idempotency ceiling does not extend that validity. An uncommitted operation with a renewed/expired binding must not silently adopt the replacement. A new preparation/request is required only after reviewing the previous operation's outcome; committed history remains recoverable independently.

Before any authorized hosted apply, run the proposed read-only `US-TAX-INVOICE-PREPARATION-PREFLIGHT.sql` and review the deployed dependency chain. Any pre-existing uncommitted observed tax operation requires explicit outcome reconciliation: the new guards must not fabricate a missing historical human preparation. Turning off the new flag prevents new operations but does not erase evidence or replace an uncertain request.

## Delivery

Provide modifications, created/modified files, proposed migration and rollback approach, actual tests/results, risks, completed scope and experimental/incomplete scope. Preserve the earlier audit and migration history.
