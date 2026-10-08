# US Automation — admission and supplier analysis

Base: `fe742ce7f5ab90e237d04e8c6acf46df835d8d17`. Development is isolated from Swiss production. This phase does not deploy migrations, enable hosted flags, create Stripe prices, contact a mailbox or purchase analyses.

## Findings verified in source

- US Auth/membership and subscription authority live in D1; US financial books and proposals use private PostgreSQL RPCs. Both must be checked. A Gestion subscription alone does not grant Automation. A Complet offer can grant both only when its US catalog entry and payment evidence are independently approved; the runtime catalog remains empty by default and tests use fictitious TEST offers. Existing authority is immutable; a complete upgrade/renewal issuer remains a later phase.
- Supplier extraction is text only and prepares a proposal. An explicit human review atomically records the existing vendor bill and balanced journal. No provider is currently bound, and no US quota is configured.
- Swiss processing consent, quotas, seats and CHF prices cannot authorize US inference.

## Implementation

1. Add strict server-only monthly-budget configuration matching independently approved US catalog/price evidence, without defaults or invented production quotas.
2. Add private company consent (initially off), revision control, immutable settings receipts, bounded jobs, durable reservations and append-only operational evidence.
3. Key usage by organization/environment/bucket/UTC calendar month, independently of plan or subscription changes. Month boundaries are a product policy, not accounting periods. A downgrade below existing usage yields zero remaining capacity; it never resets usage.
4. Reserve before dispatch. Only the first acknowledged dispatch transition permits one outbound request. A lost dispatch acknowledgement or an ambiguous provider result remains consumed/uncertain and cannot be sent again. An undispatched expired reservation can be reclaimed. This favors avoiding duplicate provider charges; it can consume quota without a confirmed result.
5. Preserve exact canonical result bytes/hash and create the supplier proposal in the same PostgreSQL transaction. A pause prevents new dispatch; completion of an already-authorized dispatch may preserve its private result under captured consent/version/period, with fresh Auth and both module rights. Completion never writes accounting.
6. Add an owner activation/admin pause panel with informative, expiring readiness. Fresh server authority always governs actual operations. Pending financial writes remain recoverable when analysis is paused.
7. Bind the existing typed-choice extractor to the pinned provider model through a single-dispatch transport. Keep runtime flags off by default and use only fictitious provider responses in tests.

## Verification and operational limits

Run strict policy, transport, HTTP, PostgreSQL migration-chain, tenant/role/revocation, quota, idempotency, UTC boundary and failure tests; TSC, syntax lint, production build, Swiss targeted regression and responsive UI checks. Preserve historical evidence folders; new evidence belongs to `.qa/us-analysis/`.

The [Supabase changelog](https://supabase.com/changelog) was fetched on 8 October 2026: framework adapter deprecation does not apply to the custom REST client; PostgreSQL 15.19/17.11 extension changes require deployment review. Follow [private database function guidance](https://supabase.com/docs/guides/database/functions), RLS and least-privilege grants.

The [TypeSafe API reference](https://docs.typesafe.ai/api) and [model reference](https://docs.typesafe.ai/models) were reviewed on the same date. No provider idempotency contract was found in that reference; this is a documentation finding, not a guarantee of absence. The US adapter therefore must not blindly retry a dispatch. Text extraction does not claim OCR, production accuracy, legal compliance, ZDR, actual provider capacity or US GAAP certification.

Production activation needs explicit approval, verified subscription/budget configuration, legal processing review and a separately approved real-provider sandbox test. No hosted migration or production financial operation is authorized by this document.
