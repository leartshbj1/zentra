# Zentra US — native purchases, seller identity and protected exports

8 October 2026. This is an incremental implementation milestone of the international ERP objective, not a production release or a declaration of US accounting/tax compliance.

## Result

The admitted US workspace now has native vendor records, supplier invoices and partial supplier payments using the same authoritative ERP controller as sales, projects and reports. Amounts are exact USD minor units. Purchase taxes are recorded costs; Swiss recoverable VAT is never inferred for a US company. The native client prepares a review and the server retains the financial role, period, balance, CAS, audit and idempotency authority.

The owner can configure the public seller name and contact details used on US documents. A historical write receipt is kept separately from the current seller head: a replay cannot roll the screen back to an obsolete profile. A fresh authorized read is required before the next write after a confirmed receipt or a CAS conflict.

PDF and CSV controls are available for estimates, invoices already issued, vendor bills, projects and five financial reports. Native Rust receives the export bytes directly from fixed HTTPS endpoints, validates their proof headers, selector/content hashes, revisions and file structure, then saves through a native dialog or shares through the existing mobile bridge. The WebView receives only a bounded receipt; no bearer, bytes or local path. A deliberate desktop rename is returned accurately, including spaces, accents and an uppercase extension.

An incoming collaboration delta previously unmounted an open sales, purchase or project form and lost its draft. The three forms now retain their fields and quote lines for the same member context. A revision change invalidates the confirmation, not the draft. The next review reads current invoices, supplier bills, payments, associations and open periods. If the edited project itself changed, its current version is shown and the user must acknowledge that version before preparing a new project CAS. Already dispatched commands are never rebased; a confirmed exact retry closes the submitted draft and creates no second payment. Actor, role, tenant or member-nonce changes still purge the draft.

## Scope and source bases

| Checkout | Base commit | Changes in this milestone |
| --- | --- | --- |
| `international-site` | `3a0ca29844650578b311ebbdcd1c508c0288ddb5` | One real-handler native integration test, evidence and delivery/next-phase documentation. Existing functional server code and migrations are unchanged. |
| `international-native-admission` | `0ae57a5c0c2846e2245c943e0b6b059d47454392` | US UI/forms/controller, three protected IPC commands, export validation/storage, fixtures/tests and scoped styles/translations. |

The companion [machine-readable evidence](../evidence/native-us-purchasing-exports-20261008.json) lists created and modified files for both checkouts, their local source hashes, exact check records and preserved-source proofs. Local-byte hashes do not claim that every source file has a platform-independent checkout encoding. Exact LF attributes cover the two new cross-client export corpus artifacts, as they already do for the reviewed shared-domain sources.

The commercial menu requested during this work was published separately from `site-business-results`, commit `b6e080ba6ad75c825c383ab5ae7282201e7f8a7f`, **Sites version 355**, deployment status `succeeded`. Its 24 route/language/width cases, German enlarged text, keyboard, reversal and reduced-motion checks are separate evidence. The site is available at `https://www.zentraapp.ch`. Do not deploy this older international branch over that published site baseline.

## Authorization and storage

- The existing US device credential remains in the Rust protected store. Each seller/export operation requires the expected workspace scope and member-context nonce before and after waits, success and failure. No CH token fallback or JavaScript-supplied URL is accepted.
- All active authorized members may read permitted documents. Public seller configuration remains owner-only; a write denial does not silently revoke a member's otherwise valid read access or discard an uncertain write.
- Export responses have strict MIME, bounded declared and streamed length, organization/USD/format/language, canonical selector SHA-256, content SHA-256 and ERP/ledger/record revision checks. PDF structure and strict UTF-8/quoted CSV are validated. Downloads are bounded to 12 MiB.
- Rust guards the admitted context again after the dialog and before atomic storage/share. Desktop paths must be local, within a safe canonical parent, outside application/internal storage, without traversal, reserved device names, symlink/reparse ancestors or an unsafe extension. The implementation does not claim protection against an arbitrary malicious process changing the operating system filesystem concurrently.
- The network deadline is bounded; the save dialog is not mistaken for a network timeout. JavaScript invalidates late responses at context changes and never exposes a full destination path.
- Source-not-found and authorization loss remain separate. Missing documents do not quarantine a valid US session. Closed feature/admission gates remain closed.

## Verification actually executed

| Check | Final result and scope |
| --- | --- |
| Server integration/regression | **329/329 tests, 7 files, no failures or skips**. Includes 17 new real US bearer/D1/HTTP/executor/RPC/export cases. Source hashes remained unchanged during the run. |
| Global web TypeScript | Exit 0 on this milestone, including the new integration test. |
| Changed server type-aware lint / diff | Exit 0. No new functional server code; no new global build is claimed for this test-only slice. |
| Native frontend regression | **151/151 tests, 17 files, no failures or skips**, on the final frozen source. Earlier 137/33/40-test runs overlap; do not sum them. |
| Native TypeScript / changed-source lint | Exit 0 after the receipt and draft fixes. The last scoped lint includes nine affected TS/TSX files with warnings denied. This is not a claim that unrelated historical CH lint is clean. |
| Native frontend production bundle | Vite-only exit 0 on final sources. The CH dark-palette generator was deliberately not rerun; the incumbent generated CH stylesheet is unchanged. Large pre-existing chunks remain. |
| Visual/functional preview | 54 initial captures, one correction batch and nine confirmations; four languages, two themes, 1440/390 widths plus selected 320px/200% text. A single additional German dark 320px enlarged-text check validates the new draft notice/current-project review. No measured overflow or JavaScript error in these bounded cases. |
| Rust formatting/diff | `rustfmt`, `rustfmt --check` and diff checks exit 0. **36 Rust tests written, 35 eligible on Windows; 0 compiled, 0 executed.** |

The server test uses actual US bearer handlers, SQLite D1 migrations 0000–0088, the existing PostgreSQL migrations through projects v3, the real executor, service-role RPCs and PDF renderers. Auth/payment evidence and the cross-database creation receipt are synthetic test ports. PostgreSQL is one serialized PGlite connection in memory. The eight cross-client PDF/CSV vectors are actual handler outputs with a retained source hash; invoice tax authority is not manufactured to generate a fixture.

The native preview mounts the real React components and exact-money executor, but Rust IPC, device admission, file dialogs and sharing are fictional ports. Its vendor/bill/payment/replay/project/seller/export journey does not prove that a native file was saved or shared. The final source review was performed by the root and reused independent backend reviewer because no new agent thread could be spawned. No broad accessibility or physical-device certification is claimed.

The prior `cargo check --lib --offline` was refused by Windows Application Control with OS error 4551 before this application crate compiled. This milestone does not retry or bypass that protection. A Vite bundle and source formatting cannot establish Rust correctness or a runnable installer.

## Migrations, production and rollback

**New migrations: none. Production/staging migrations applied: none.** The existing additive admission, country, seller, tax, ERP v2 and projects v3 proposals remain intact and were reused locally. No customer data, company, paid period, CHF Price ID, QR invoice, Supabase region or CH business function is changed by this slice.

No US/native production flag, real fiscal gateway, new USD price, payment or native release is activated. Invoice issuance remains unavailable without a trusted configured tax provider. The interface displays this limitation; the presence of an invoice export control cannot create an invoice.

Rollback means disabling the new US client surfaces/IPC registrations and keeping the existing US admission gates closed, while preserving authoritative records, receipts and audits. Do not delete committed financial documents, reset databases or reinterpret uncertain requests. Any future hosted migration or activation requires staging, explicit approval and a compatibility/recovery plan for the supported native capabilities.

## Finished and still experimental

Implemented and locally verified: native purchase preparation/review, exact payment recovery, shared multi-menu state, public seller configuration/fresh head, strict export client contracts, preserved collaborative drafts, language/theme/responsive checks and the actual server integration test.

Implemented but not executable here: Rust protected seller/export gateway, save/share destinations and written adversarial Rust tests. The entire US edition remains experimental until a runnable native build, hosted authorization, two real installations, real PostgREST/SQL concurrency/crash recovery and release testing are verified.

Remaining ERP work is explicit rather than hidden behind a completed label: real US tax issuance, tax transactions/reversals and expanded goods/exemptions; sales orders/delivery/recurrence/credit notes/deposits; purchase orders/vendor credit notes/original-document uploads; manual journal and period-opening screens; durable bank reconciliation/payment provider; international Support/Automation sinks and approved USD subscription activation.

The next audited vertical is [journal and accounting periods](US-JOURNAL-PERIODS-RUNTIME-PLAN-20261008.md), because without an opening balance/manual journal and another period, a real bank reconciliation cannot be complete. In parallel, [native tax issuance](NATIVE-US-TAX-ISSUANCE-PLAN-20261008.md) records the real provider and readiness gates. Both are plans, not claims of implementation or legal certification. Applicable professional accounting/tax/privacy review from `US-REGULATORY-MATRIX.md` remains required before production.
