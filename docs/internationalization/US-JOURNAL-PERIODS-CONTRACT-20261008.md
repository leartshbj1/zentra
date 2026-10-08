# US accounting runtime v4 contract

8 October 2026. Implementation contract for the isolated US journal/period vertical, from source `90d131646a352e149c03b80b9260ec8eda724a2d`. No production activation, price/provider grant or CH behavior change.

## State, capability and historical identity

- Schema4 has exactly the schema3 state/header fields: purchases arrays, projects array and `counters.project` required; no new collection or counter. Historical heads/events1–3 keep their exact shapes and data.
- `initialize` on a trusted server store capability4 creates schema4 with empty real-new-book arrays and counters0. Capabilities1–3 retain the original initialize→schema1 behavior. A client cannot supply a schema version in the command.
- `upgrade_accounting {type}` is owner-only, permitted only from schema3 with capability4. It changes only schemaVersion3→4 plus the normal global revision. No record changes, ledger audit or ledger revision/counter change; receipt.entityId is the organization ID. Already4 with a new key is `accounting_already_upgraded`409; old exact replay remains valid. Schema1/2 must use their existing reviewed promotions; no dummy project or legacy-reference erasure is introduced here.
- New accounting commands require capability4 and an actual schema4 book (`accounting_unavailable`409 / `accounting_upgrade_required`409). Existing commands preserve schema4 instead of downgrading it. Existing reads/receipts/deltas remain versioned; old capable readers refuse an upgraded head (`PU008` / `client_upgrade_required`409).
- Receipt stays the exact five fields `{idempotencyKey,commandHash,revision,entityId,action}`. Event schema/header matches the actual committed head. Default capability remains1. New initialization4 and the exact upgrade transition are admitted by v4 delta; historical events1–3 retain their tags.

## Commands and derived durable records

All commands use the existing exact ERP envelope/key and global CAS. Identifiers/source references are nonblank UTF-16 strings <=160, with no control, NUL or malformed surrogate. Dates are real nonzero-year civil YYYY-MM-DD. Optional fields may be omitted, never supplied as null.

| Command | Exact input after `type` | Effect / receipt entityId |
| --- | --- | --- |
| `open_period` | `id,start,end` | Append exactly one open period after the maximum existing end, no overlap or reused ID, end>=start, total<=100. Header period append, ledger revision+1, one `period_opened` audit, no record changes. entityId=period ID. |
| `post_manual_journal` | `id,transactionDate,accountingDate,periodId,description,sourceReference,lines,cashFlowCategory?` | Exactly one immutable journal record and one posted audit. Journal.id=input.id, journal.idempotencyKey=ERP key, source exactly `{type:'manual_journal',id:sourceReference}`. entityId=entry ID. |
| `reverse_manual_journal` | `id,entryId,transactionDate,accountingDate,periodId,reason` | Exactly one new immutable journal reversing a `manual_journal` only. source exactly `{type:'manual_reversal',id:original.id}`, reversesEntryId=original.id, description=reason. entityId=new entry ID. |
| `close_period` | Existing `periodId` | On schema4, close the earliest still-open period only, one `period_closed` audit and ledger revision+1; no records. Existing schema1–3 semantics/reconstruction stay unchanged. |

`description`/`reason` are nonblank <=2000 without control characters. Lines are a dense array of2–1000 exact `{accountId,debitMinor,creditMinor,description?}`; optional description follows the same bound. Minor units are canonical unsigned integer strings, max36 digits; each line has exactly one nonzero side and total debit=credit>0. Accounts must exist, and `receivables`, `payables`, `tax-payable`, `deposits` are forbidden for manual journals/reversals. Net cash movement requires explicit `operating|investing|financing`; reversal preserves the original category exactly. Reversal lines preserve original optional descriptions and account order, with debit/credit swapped. At most one reversal per original. No journal changes a customer/vendor balance or creates a tax/payment grant.

Journal organization/currency/basis, key, postedBy/postedAt, ledger revision and fingerprint are server-derived. There is no extra journal approval/provider field: the explicit command and its posted actor/audit record human approval; sourceReference is durable through source.id and participates in the existing fingerprint. No client actor, total, source, reversal lines or journal DTO is accepted. Final composition occurs after the last fresh revalidation, with no await before commit. All newly generated audit/journal timestamps use the final actor instant (UTC Z, zero or3 fractional digits); the SQL receipt/event uses that same instant normalized to milliseconds, accepting Z/.000 equivalence. Existing history remains unchanged.

## Reconstruction and transaction fences

Schema4 reconstruction derives initial periods by excluding IDs introduced by validated `period_opened` events, creates the initial open ledger, then replays all audit revisions in order. A period_opened event derives its exact dates from the immutable final period with matching ID, appends exactly once, and must precede any posting/closure in that period. Posted manual/reversal records are rebuilt from their permitted fields and compared exactly, including fingerprint, actor/time, revision, key and optional fields. Legacy closed events in a promoted book retain their original semantics; only new v4 close commands/deltas enforce oldest-open order.

The same `zentra_commit_us_erp` transaction CASes head, records, ledger audit, receipt and event. New SQL must correlate the one permitted record/header transition with action/entityId/key/final actor timestamp and exact inverse/period changes; a balanced fabricated journal is not enough. Upgrade changes no financial data. Immutable records/audit/receipts and original v1–3 rules remain fenced, RLS/internal service_role unchanged. Replays stay actor/request-hash scoped and require fresh admission before disclosure. Device capability4 is a newly captured maximum, never an in-place upgrade of a capability3 credential.

## Controlled error codes

Existing stable ERP/Ledger codes retain their contracts. New public failures: `accounting_unavailable`409, `accounting_upgrade_required`409, `accounting_already_upgraded`409, `period_limit_reached`409, `period_already_exists`409, `accounting_period_order_conflict`409, `manual_account_forbidden`422, `manual_journal_required`409. Missing reversal entry=`entry_not_found`404; repeated/invalid reversal=`invalid_reversal`409; closed target=`accounting_period_closed`409; malformed shape=`invalid_request`422, date=`invalid_date`422, period bounds/order=`invalid_period`422, invalid amount=`invalid_amount`422. Other reused ledger validations are normalized by the current runtime ledger error boundary; no raw payload/message or invented privilege is returned.

## Shared facade exports

New `lib/international/accounting/us-journal.ts`: types `UsOpenPeriodInput`, `UsManualJournalInput`, `UsManualReversalInput`; pure strict frozen validators `validateUsOpenPeriodInput`, `validateUsManualJournalInput`, `validateUsManualReversalInput`; operations `openUsAccountingPeriod(ledger,input,actor,expectedLedgerRevision)`, `postUsManualJournal(ledger,input,key,actor,expectedLedgerRevision)`, `reverseUsManualJournal(ledger,input,key,actor,expectedLedgerRevision)`, `closeUsAccountingPeriod(ledger,periodId,actor,expectedLedgerRevision)`. They accept verified FinancialAuthority, never construct an authority from input. The only shared CH file change authorized is widening LedgerAuditEvent.action TYPE to include period_opened; no shared CH function changes.

Local engine/domain/delta and PG/D1 handler tests validate this contract within the scope recorded in US-JOURNAL-PERIODS-DELIVERY-20261008.md. Hosted Auth, two-connection concurrency, crash recovery, a runnable native release and production remain unproved/default closed.
