# Next isolated native US slice — purchases and protected exports

8 October 2026. Read-only follow-up audit after the native admission milestone. This is a plan, not an implemented feature or production activation. The previous admission milestone remains default closed.

## Smallest complete workflow

Reuse the one admitted `InternationalErpSession`: vendor → reviewed vendor bill → partial payment → ledger/report → PDF/CSV. A payment records an accounting operation; it does not transmit funds to a bank. US purchase tax is part of the purchase cost in the current engine, never a Swiss recoverable VAT credit. Preserve exact cents, dated transactions/accounting/payments, approval history, period status, global revision and idempotent receipts.

Do not copy CH purchase records into the US book, build a second SQLite finance store, or reuse CH document generation as a US issuer.

## Verified server contracts

All routes have the fixed base `/api/international/workspaces/{organizationId}`. A native Authorization header is read only by `requireUsDeviceSession`, then current US authority and configuration. There is no cookie or CHF fallback. Announce `X-Zentra-Erp-Schema-Version: 3`; the server's effective capability still independently requires its flags.

- `GET /erp`, `/erp/revision`, `/erp/changes?after=N&limit=1..100`: active members, one book and delta stream.
- `POST /erp`: exact `{idempotencyKey,expectedRevision,command}`. `save_vendor`, `record_vendor_bill`, `record_vendor_payment` require owner/admin/accountant and schema capability at least 2. Command DTOs are in `erp-request.ts`, not inferred from UI fields.
- `GET /exports/documents/{estimate|invoice|vendor_bill|project}/{id}?format=pdf|csv&language=fr|de|it|en`; project exports require capability 3.
- `GET /exports/reports/{trial_balance|profit_loss|balance_sheet|cash_flow|general_ledger}` with the exact supported date/account selector. Point reports use `asOf`; period reports use `start/end`; general ledger also requires `accountId`.
- `GET/PUT /seller`: all active roles may read the public profile; only owner may write. Writes use expected revision, requestId and an immutable receipt.
- `GET/PUT /tax-profile`: owner only, including reads. It is declared unverified and grants no tax calculation or invoice issuance. Keep this private configuration outside the first purchasing/export slice.

The export server already renders a public whitelisted snapshot, checks current authority before and after render/font/hash work, and supplies selector/revision/content proofs. An invoice uses its archived seller; other documents use the current seller. A configured seller is needed for usable exports. No new business migration or tax provider is required for the reviewed purchasing slice.

## Native changes to implement

1. Add `NativeUsPurchases.tsx` using the existing session and review step. Vendor selection, stable vendor snapshots, supplier invoice reference, open accounting period, exact net/purchase-tax and source reference must be explicit. Only the authorized financial roles receive write controls. Rows remain readable to other active members.
2. Add a Rust **enumerated** export request port. JavaScript supplies a typed document/report selector, format/language and the original scope/nonce; never a domain, URL, bearer or replacement organization. The vault supplies the credential and selected tenant. Keep HTTPS/no redirects and no automatic write retry.
3. Retain response headers privately. The existing US ERP `(status,bytes)` transport loses these headers and has an 8MiB limit, so it is not sufficient for exports. Validate Content-Type, declared and streamed length, server limit 12MiB, PDF magic or UTF-8 CSV, SHA-256 bytes, organization, USD, language, format, selector SHA-256, ERP/ledger revisions and the optional record revision. Compare against the exact requested selector; do not accept arbitrary server filenames.
4. Check the US protected stamp before request, after either network outcome, and before exposing/saving/sharing the result. No protected-store lock spans a network wait. If a company, role, session, nonce or capability changes, discard the bytes and suppress local output.
5. Save atomically to an explicit user-chosen safe destination. Existing `chooseSaveFile` and temporary-file `sync_all`/persist mechanics can be reused, but their CH data lookup/authorization cannot. A minimal absolute-path/PDF-extension check does not prevent overwriting internal application files or traversing a symlink: add US-specific destination protections. On mobile use a dedicated US export folder and origin-bound sharing; do not broaden WebView filesystem/asset permissions.
6. Export buttons belong beside the corresponding document and report. File generation stays in Rust/server, not a financial recomputation in the WebView. Keep mobile targets, clear progress/errors and a readable preview consistent with the existing Zentra shell.

## Correctness boundaries found during the follow-up audit

`vendorBillBalance` requires payments for a single `billId`. Project rollups must filter payments for each bill; passing every payment can make a multi-bill dossier fail. This defect is being corrected in the admission milestone rather than being left for the new screen.

The server can withhold a receipt after a committed transaction if final authorization/configuration validation fails. In particular, `configuration_changed` is not proof of no commit. Preserve the original byte-exact request/key while the same admitted identity remains and prohibit a new key for an unresolved operation. Proven precommit CAS/idempotency conflicts and local validation can be handled separately. Never transplant a pending operation across accounts or companies. This is also an admission-milestone correction.

For exports, `export_source_not_found` (404) does not mean the session is invalid. Distinguish it from `feature_unavailable` and actual loss of authority. An owner-only profile refusal must not disconnect an otherwise admitted accountant. Existing generic status-based invalidation must not be copied blindly into the new port.

## Acceptance and release gates

Test real shared executor persistence/replay: two bills, one unrelated payment, both accounting bases, supplier snapshot, duplicate reference, exact partial payment, overpayment refusal, closed periods, role restrictions, response loss and postcommit configuration change. Cross-company/role/nonce changes must mask results and never create a second payment.

Export tests must cover tampered headers/hash/selector/currency/revisions, wrong MIME/length, truncated PDF/CSV, timeout and stalled body, oversized output, missing source versus closed flag, revocation during rendering or save, symlinks/internal destinations, cancelled save, mobile sharing and local atomic-write failure. No shipping UI button may rely only on a mock file port.

Preserve schema 1/2/3 and CH source/storage/licence behavior. Run native TypeScript, lint, focused integration/browser tests and build; run Rust tests/check when the host can execute them. Windows application control currently prevents the Rust dependency build executables, so a frontend preview cannot be called a validated native release. Hosted Auth/PostgreSQL/D1 and a runnable native two-installation smoke remain required before production. No migration, data move, USD price, real provider binding or distribution is authorized by this plan.
