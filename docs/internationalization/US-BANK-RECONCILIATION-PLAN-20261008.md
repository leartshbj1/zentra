# US bank reconciliation — next delivery boundary

Base web `ce64382ff53600ed13a3d497e05f33f13703787a`, native `bbf0985d2df8d9c66445b71fc6d981276b0d65dc`. No source from the published menu or Swiss book is changed by this lot.

The existing pure reconciliation engine is not a durable user feature. Implement an isolated US bank-review store alongside the schema4 ERP book: manual USD CSV import, immutable reviewed statements, explicit exact matches, completion and audited void of an unmatched unfinished import. The bank module never posts or deletes a journal, transfers money, stores bank credentials or invents tax/fees. No schema5 or automatic promotion.

`us-bank-contract.ts` is the shared typed transport. Statements use opaque connection IDs. Commands are `create_statement`, `approve_match`, `complete` and `void_statement`. Creation revision is0; subsequent commands increase the reconciliation revision exactly once. Replay is actor/scoped and requires the exact canonical request hash. Current financial authority and trusted book capability are always checked before a receipt can be disclosed.

The PostgreSQL commit locks country configuration and the actual ERP head, checks its expected revision/currency/country/schema and the reconciliation CAS, then writes the reviewed state and receipt together. It preserves a separate audit and prohibits overlapping active periods for the same cash account, duplicate immutable imports and matching the same cash journal to two active reconciliations. An import may be voided only with no matches and no completion. Historical records/audit/receipts remain stored; void is no journal correction.

HTTP uses the existing verified browser/device admission and configuration. Only owner/admin/accountant can use this financial read/write surface. GET is scoped, bounded and no-store. POST requires exact request fields and captured schema4; device credentials cannot upgrade themselves through headers. Fresh admission after awaited reads and writes, exact replay, stale responses, lost replies and authority changes are tested separately from PostgreSQL integrity.

UI: a simple import/review/match sequence in the US accounting surface, four existing languages, desktop/mobile, clear unfinished differences. Imported values are exact decimal USD and explicit ISO dates, never localized guesses or binary floats. Suggestions are informative; the user approves associations and completion. Low confidence or missing journal movements remains unresolved rather than automatic adjustment.

Deliver additive SQL generated through the available Supabase CLI, local disposable PG tests, core/HTTP/store/UI tests and production builds. No hosted migration, provider connection, real statement, subscription change, native installer or US compliance certification is authorized by this plan. Current source evidence and execution limits are preserved in a new delivery artifact; old proofs are never rewritten.
