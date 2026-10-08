# Proposed US vertical — journal and accounting periods

8 October 2026. Read-only source audit, then documentation only. Server source audited at `3a0ca29844650578b311ebbdcd1c508c0288ddb5` in `international-site`. The pending purchasing/export test and evidence files do not add accounting commands. This document proposes the next complete vertical; it does not implement schema4, apply a migration, admit a user, activate a flag, or authorize production.

## What is operational, partial, or absent

| User capability | Current evidence | Boundary |
| --- | --- | --- |
| Durable sales/purchase journal | `runtime.ts:132–152,182–203`; `accounting/postings.ts:25,52,70,82` | Invoice/payment sources produce accounting entries in the same ERP CAS book. A recorded payment does not transfer funds. US purchase tax remains a cost, not recoverable Swiss VAT. |
| Five accounting reports and protected exports | `components/account/us-erp-reports.tsx:76,94,108–110`; `export-server.ts:132–140` | Trial balance, profit/loss, balance sheet, cash flow and general ledger use validated book data. PDF/CSV exports already enforce current admission and capability after rendering/hash work. |
| Initial periods | `erp-request.ts:51–53`; `runtime.ts:87–89`; `components/account/us-erp-workbench.tsx:72,326–327` | The initial API accepts explicit periods; the current browser form creates one. There is no later period-opening command. |
| Period closure | `runtime-types.ts:67`; `runtime.ts:203`; `20261008105120_international_us_projects_v3.sql:569` | `close_period` is a durable financial command. No closure control is wired in the audited US web/native screens. A label in a review component is not a callable UI workflow. |
| Manual journal and reversal | `accounting/ledger.ts:95,135` | Reusable library functions, not US ERP commands. `runtime-validation.ts:85–110` reconstructs only customer invoice/payment and vendor bill/payment sources; any other posted source fails validation. |
| New/future periods | `runtime-sync.ts:93`; `20261008105120_international_us_projects_v3.sql:319–333` | Existing period dates/IDs are immutable, only the exact close operation can change status, and SQL forbids changing the number of periods. A new fiscal period cannot currently be added to an initialized book. |
| Bank reconciliation | `accounting/reconciliation.ts:21,32,49,62` | Pure library and unit tests only. No reconciliation command, entity collection, durable RPC, HTTP route or US screen was found among their consumers. No bank connector or payment execution is established. |

These distinctions are verified against [the command union](../../lib/international/runtime-types.ts#L55), [the executor](../../lib/international/runtime.ts#L203), [stored-state reconstruction](../../lib/international/runtime-validation.ts#L75) and [current SQL period constraints](../../supabase/migrations/20261008105120_international_us_projects_v3.sql#L319).

The experimental native checkout is a separate source: `D:/Codex-Zentra-Temporary/2026-10-08/international-native-admission`, admission base `0ae57a5c0c2846e2245c943e0b6b059d47454392`, with the new purchasing/export UI reviewed separately before its commit. `desktop/src/NativeUsReports.tsx:17–23` computes the five reports from the validated US book; `InternationalErpPilot.tsx:122,142–144` initializes a period and mounts projects/purchases/reports, without an accounting-management screen. `AccountingScreen.tsx:456,473` calls the historical CH desktop journal/reversal API; it is not evidence of US functionality. `NativeAdmissionRoot.tsx:33–34` keeps the CH and US branches distinct. This source is not a validation of the published CH desktop binary.

## Next complete user workflow

Implement **review a future period → record an approved manual USD journal → counterpost that manual entry if needed → close a period → inspect the journal/audit and export the general ledger**. This solves the inability to continue into a later accounting period and supports opening capital/bank fees that a later reconciliation workflow needs.

Reuse `postJournal`, `reverseJournal` and `closePeriod`, with a strict US command facade and durable validation. Reuse the current reports and export renderer; do not create a second accounting database or another financial authority. The starter chart already includes cash, equity, fixed assets, purchases and bank fees (`countries/us/accounting.ts:4–15`). It is explicitly a starter chart, not mandated accounting policy or GAAP certification.

Proposed command names and fields, to fix as one implementation contract before code:

- `open_period`: explicit period `id`, `start`, `end`. Append a bounded, non-overlapping future period; do not infer a fiscal year, replace previous boundaries, reopen or delete a period.
- `post_manual_journal`: entry `id`, transaction/accounting dates, period ID, description, a bounded human `sourceReference`, exact account/debit/credit lines, and an explicit cash-flow category when cash moves. The existing ERP envelope owns `expectedRevision` and the immutable idempotency key.
- `reverse_manual_journal`: new entry `id`, original entry ID, correction dates/period, reason and source reference. The server derives the exact reversed lines, original link and cash classification; the client cannot supply replacement amounts.
- `close_period`: retain the current command but add a useful review/action in the journal/period screen, including the accounting cutoff it creates.

The posted manual source must durably record `approvalSource: 'manual_entry'`, source reference/reason and the actual approving actor/time. Existing `postedBy`/`postedAt` can represent that approval if the final DTO contract makes the correlation explicit; do not duplicate a spoofable client actor field. Every immutable business field must participate in command identity and journal reconstruction. The current `journalFingerprint` omits any future metadata (`ledger.ts:93`), so simply spreading extra fields into a journal would be insufficient.

Manual writes/period management require the current financial roles owner/admin/accountant and current US management entitlement (`runtime.ts:26`; `ledger.ts:67–71`). Owner-only initialization/configuration rules stay unchanged. Active nonfinancial members retain authorized book/report reads. Organization, USD currency, accounting basis, source type, approving actor, timestamp, revisions and derived reversal lines are server-owned, not grants in a request body.

Start reversals with **manual entries only**. Do not directly reverse customer/vendor invoice or payment journals while their immutable operational records and balances remain unchanged. Receivables, payables and sales-tax-payable adjustments also need an explicit subledger/tax correction contract; exclude them from this initial manual-entry scope rather than silently bypassing invoice/payment invariants. No sales-tax assessment, VAT credit, bank transfer or invoice issuance entitlement follows from a balanced manual journal.

## Exact invariants and historical replay

- Amounts remain canonical integer minor-unit strings, with current safe length bounds and BigInt arithmetic; no float totals. Require known accounts, nonzero lines, exact debit/credit balance and explicit operating/investing/financing classification for cash (`ledger.ts:114–124`).
- Preserve transaction date versus accounting date. No UTC-derived civil date. All new writes use a real open period containing the accounting date and respect the cutoff from every closed period (`ledger.ts:110–113`).
- Present chronological closure clearly: closing a later period currently blocks earlier accounting dates even if an earlier period still says open. Prefer oldest-open-first for new closure operations; do not retroactively reject or rewrite existing histories created under the current rule.
- Append journals and audit only; counterposting is a new linked entry, at most once per original, with exactly reversed lines (`ledger.ts:125–138`). No destructive edit, silent reactivation or automatic profit-closing entry.
- Use the same global ERP CAS, ledger revision and immutable receipt/event transaction (`runtime-types.ts:38–53`). Advance only the appropriate revisions, keep estimate/invoice/project counters unchanged, and compose final approving timestamps after the last admission revalidation without an intervening await.
- Preserve the exact request/key until a reliable outcome. A response withheld after commit is not proof of rejection. Retry under the same freshly admitted identity returns the original receipt after later writes or closure; no automatic new-key resubmission. Keep Auth/rights errors controlled and revalidate before disclosure.
- For a new `period_opened` audit event, replay must start from the original initialization periods, then apply additions chronologically. The current reconstruction starts with **all final periods** open (`runtime-validation.ts:75–76`); copying that algorithm into v4 would erase the proof that a period existed when an entry was posted. Identify added periods from validated audit events and reconstruct the initial set, with no duplicate/missing/unused addition event.

## Proposed schema/capability 4 — not available today

This is a semantic protocol upgrade even if journal/period data remains in the existing ledger rather than a new collection. Older validators reject new journal sources/actions/audit events; serving them a partially understood book would be unsafe.

Current capability is exactly `1 | 2 | 3` (`erp-schema-capability.ts:6–15`), and stores default to 1 (`runtime-store.ts:43–57`; `runtime-sync-store.ts:13–19`). Current promotion rules and legacy `PU008` fences are in `20261008105120_international_us_projects_v3.sql:256,286–290,786–807`.

The v4 contract must preserve untouched schema1/2/3 heads and every original receipt/event byte-for-byte, with no read-time insertion of empty collections, project counters or imaginary records. Promote only as part of an explicit new accounting command, never a read/configuration refresh; prior events retain their original headers. Fix the exact v4 collection-presence/promotion contract before implementation: do not require users to create a dummy project merely to open an accounting period. If promotion requires a project registry and legacy `projectId` references exist without materialized projects, retain the existing explicit review requirement; never erase/invent those links. A new registry/counter may only be introduced by an explicit, reviewed promotion whose empty source is actually established.

Add explicit `_v4` read/receipt/revision/delta RPCs and preserve original event schema tags. A v4 consumer must apply old events followed by the first v4 event. Old v1/v2/v3 readers and receipt lookups must refuse an upgraded head with `PU008`; replay through a capable v4 caller may return the original exact historical receipt without rebuilding a new command. No downgrade to an earlier schema after a v4 commit.

Use a **new Supabase CLI-created versioned migration**, never edits to historical SQL. Extend the same `zentra_commit_us_erp` CAS transaction for exact command/source/period/reversal/audit/receipt correlations. The new migration must widen the audit action constraint (`20261007222349_international_us_erp_persistence.sql:44–50`), keep immutable history triggers (`:111–112`), preserve existing sales/purchase/tax/project guards and their rollback behavior, and keep RLS plus revoked PUBLIC/anon/authenticated access (`:503–514`). Internal service-role SQL is not a replacement for current Auth/D1 admission.

Native capability 4 additionally needs a **new additive D1 migration**: `drizzle/0088_international_us_device_admission.sql:23,43` currently permits only 1/2/3, and `:64,81,88` captures capability immutably in the authorization/session. `us-device-contract.ts:24` also rejects 4. Do not rewrite the historical migration or upgrade a captured capability 3 under the same credential. A client explicitly announcing 4 needs matching admission support; current capability 3 credentials retain their contract. Browser v4 could be delivered first only if the native limitation is declared, not presented as a completed native vertical.

## Files and boundaries for implementation

| Layer | Concrete files / responsibility |
| --- | --- |
| Accounting facade | New US-specific command validator/factory, reusing `accounting/ledger.ts`; strict manual source/approval/reference and reversal reconstruction. Shared CH semantics remain unchanged. |
| ERP protocol/executor | `runtime-types.ts`, `erp-request.ts`, `erp-schema-capability.ts`, `runtime.ts`, `runtime-validation.ts`, `runtime-sync.ts`, `runtime-store.ts`, `runtime-sync-store.ts`; exact v4 negotiation, commands, receipts, promotion and chronological reconstruction. |
| Fresh admission / output | `runtime-bindings.ts`, runtime/sync HTTP capability readers, `export-bindings.ts`, `export-server.ts`, public readiness and browser transports. Fresh effective capability and Auth/US rights must be checked precommit and after the final awaited work. Preserve the current guards in `runtime-server.ts:87–95,124–127` and `export-server.ts:132–140`. |
| Durable database | One new PG migration for v4 guards/RPCs, plus an additive D1 capability migration if native4 is included. No new licence/catalogue or parallel authority. |
| Browser workflow | `components/account/us-erp-workbench.tsx`, a dedicated journal/period view, existing reports, scoped copy/styles and tests. One admitted ERP session/CAS stream; read-only roles have no financial controls. |
| Experimental native workflow | Native US command/validator/capability ports, admitted session/Rust negotiated maximum and US-only journal/period UI. Reuse the US session and document/export controller, not `AccountingScreen` or its CH SQLite API. |

Reuse the latest draft safety approach: preserve a form during an unrelated global revision change, invalidate its confirmation, show fresh period/balance/source information, and require another review before a new CAS. Purge drafts immediately on account/tenant/nonce/role loss. An uncertain submitted envelope remains separate and immutable; once its exact retry is confirmed, close that submitted form so it cannot accidentally become a second payment/journal.

## Acceptance tests for the whole vertical

Existing tests are useful foundations, not evidence that this proposed vertical already works: `finance.test.ts:30,37` exercises library replay/reversal, `runtime.test.ts:66` exercises closed-period refusal, and `runtime-postgres.test.ts:103,158` persists closure and delta with the current commands. No test was rerun for this documentation-only audit.

Require the following connected tests, including real local PostgreSQL/PGlite with the full versioned migration chain and real handler/executor paths:

1. Initialize → explicitly open a future period → post exact approved journal → reverse into an open period → close → read/delta/report/real PDF/CSV export. Check cash and accrual books, unchanged document counters, exact revisions/audit and one linked reversal.
2. Refuse bad/overlapping/replaced periods, duplicate IDs, noncalendar dates, posting before a period-opening event, closed cutoffs and unauthorized closure. Preserve old historical closure behavior and initial period sets when reading schema1/2/3.
3. Refuse unbalanced/zero/malformed amounts, unknown or excluded control accounts, injected actor/role/source/timestamps, tampered balanced journals, altered fingerprints, wrong reversal lines and a second reversal. Test exact integers above 2^53 within domain bounds.
4. Exercise old head1/2/3 replay, v4 promotion, old-client `PU008`, no downgrade, v4 old→new delta sequence and historical receipts after later writes/closure. Test legacy project-reference review without clearing references or creating a fake project.
5. Inject failure at each SQL write: no partial head, journal, audit, receipt/event or counter change. Test response loss and revocation/configuration/flag changes after commit: retain the exact key, withhold data, recover once under the same valid identity, never post twice.
6. Cover owner/admin/accountant writes versus member/read_only denial before business effects, browser expected-user and native scope/nonce/capability mismatches, capability4 closed during work, and current admission revoked after rendering/hash. Include a real CH/CHF sentinel proving no CH mutation or legacy licence change.
7. UI tests type actual draft fields, advance the book collaboratively, verify retained values and invalidated confirmations, select a period that becomes closed, and retry a genuinely committed/lost response. Purge on actor/tenant/role loss; verify four-language/mobile accessibility separately without mistaking screenshots for backend/native proof.

## Rollback and release gates

Apply nothing in production from this plan. Proposed activation requires core + US ERP + a separately defined default-closed accounting-v4 capability gate, and only the supported purchasing/project capabilities; a client header never enables a server feature. `runtime-bindings.ts:21,26–28` currently owns the existing closed-by-default flag checks, not an accounting-v4 flag.

Before any production proposal: install and validate the additive schema with flags closed, prove old books/receipts remain accessible through their original routes, exercise full staging Auth/D1/PG/browser/device flows, concurrent two-connection CAS/replay/locking, interruption/recovery and backup/restore, then prove a runnable native build and two-installation smoke if native4 is claimed. Local serialized RAM PGlite and injected Auth/entitlement ports do not prove hosted policy, crash/restart durability or concurrent production operation. No new USD price, provider admission or published CH binary is established by this plan.

Transaction failure must roll back all writes. Operational feature rollback closes new v4 access/writes; it does **not** erase journals/audit, reopen periods or downgrade an upgraded head. Older code cannot safely read a book it no longer understands. Retain the additive migration and a compatible recovery path, with snapshots/restore procedures tested in staging; do not roll back by editing immutable history or silently falling back to CH. Existing v1/v2/v3 books remain on their unchanged contracts.

## Bank reconciliation after this vertical

The reusable library performs exact, human-approved many-to-one matching (`reconciliation.ts:31–47`), computes opening/closing from dated cash movements (`:54–60`), and pins completion to the ledger revision (`:62–67`). This makes recorded opening capital and fees important prerequisites; do not fabricate reconciliation adjustments to make balances agree.

A later full reconciliation vertical needs durable statement/import identity and human match/complete commands, cross-statement deduplication and global match uniqueness per organization/cash account, immutable approval history, CAS/idempotence and a visible status when the ledger changes. The existing duplicate check is only inside one statement (`:41`); it does not prevent a cash entry being consumed again in another imported/overlapping statement. No live provider is needed to start with an explicitly reviewed statement import, and no provider, bank connection, transfer or automatic fuzzy posting should be implied by that local workflow.
