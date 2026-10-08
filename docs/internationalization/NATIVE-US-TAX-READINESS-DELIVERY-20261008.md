# Native US TEST tax readiness — delivery, 2026-10-08

This additive lot connects the existing native US invoice editor to a short-lived public readiness projection. It does not activate a production tax provider, change Swiss behavior, move data, or publish a native release. The native checkout is based on `3e35b81ea17b33e46108c7b299a78b100118d4d5`.

## Behavior and boundaries

- `read_us_tax_readiness` reads the fixed authenticated US workspace endpoint through the existing Rust vault and captured workspace/nonce. Public data has a strict schema, USD organization/capability binding, and a lifetime of at most 120 seconds. Private tax facts, credentials, provider keys and responses never enter JavaScript.
- Schema 4, USD, an active subscription or a configured profile cannot alone enable issuance. The server must return a fresh `ready_test` observation for the same admitted actor and actual book. Member/read-only projections remain blocked without inspecting private tax profiles. Authentication or authority loss quarantines the native origin.
- A filled invoice draft remains visible on readiness expiry or a blocked provider. Expiry, a new observation or a changed ERP revision invalidates its confirmation. A fresh explicit review checks the current estimate, dates and open period. Confirmation rechecks readiness before the write; the server remains the financial authority.
- Ambiguous fiscal failures preserve the exact pending envelope, key, IDs and dates. Recovery remains available while the current readiness is blocked, allowing a committed request to replay without a duplicate invoice. Actor/nonce changes purge drafts and pending commands according to the existing session boundary.
- The UI labels this path TEST in French, German, Italian and US English. The review displays accounting-period dates instead of its technical ID. The displayed pre-issuance amount is net; tax and the final total come only from the server-issued invoice.

## Files

Nine existing files changed: `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/us_admission.rs`, `desktop/src/InternationalErpPilot.tsx`, `desktop/src/NativeUsWorkspace.tsx`, `desktop/src/internationalErp.ts`, `desktop/src/nativeUsAccountingBoundary.test.ts`, `desktop/src/nativeUsCopy.test.ts`, `desktop/src/translationsNativeUs.ts`, and `desktop/tests/native-us-admission-preview.tsx`.

Nine new source/test files: `desktop/src-tauri/src/us_tax_readiness.rs`, `desktop/src-tauri/src/us_tax_readiness_tests.rs`, `desktop/src/nativeUsTaxReadiness.ts`, `desktop/src/NativeUsTaxReadinessStatus.tsx`, `desktop/src/translationsNativeUsTax.ts`, `desktop/src/nativeUsTaxReadiness.test.ts`, `desktop/src/NativeUsTaxIssuance.test.tsx`, `desktop/src/nativeUsTaxBoundary.test.ts`, and `desktop/tests/native-us-tax-readiness-review.mjs`.

The contract and regulatory-gates documents are supplied by the parent web lot. The shared domain, Swiss account/financial bridges, generated Swiss dark CSS and historical journal evidence are not changed by this lot.

## Executed checks

- Final targeted native frontend regression: **21 files, 203 tests passed, no failures or skips**. This includes strict public projections and expiry, cash/accrual invoice issuance through the real in-memory ERP executor with explicitly mocked readiness/provider ports, lost-reply exact replay, fresh closed-period refusal, actor purge, and four-language dynamic messages.
- Final native TypeScript: exit 0. Syntax lint: 14 changed TS/TSX/QA files, 191 rules, no diagnostics. Type-aware lint could not start its Windows `tsgolint` binary; its failed attempt is retained and is not reported as a passing lint.
- Final Vite-only frontend production build: exit 0, 1.86 seconds. The existing large-chunk warning remains. No generator that rewrites `dark.generated.css` was run.
- Rust formatting for the three scoped US files: exit 0. A broader check including the incumbent `lib.rs` reports existing module-order formatting; no unrelated reordering was applied. Rust compilation and Rust test execution: **zero**. Nine new Rust tests are declared; the durable evidence also records current per-file US test declarations, without claiming execution.
- `git diff --check`: exit 0. Boundary tests verify preserved Swiss/shared source content; durable evidence records raw and LF-normalized hashes separately so Windows line-ending normalization is not confused with a business-code change.

## Bounded visual evidence

The initial browser batch has **18 configurations**: four languages, light/dark, desktop 1440 px and mobile 390 px, plus two 320 px cases with root text at 200%. It found zero horizontal overflow and page errors, exactly one invoice editor and zero writes before confirmation. Its functional journey verified expiry-preserved fields and one exact replayed invoice using the real RAM executor and mocked Rust/readiness/provider.

After replacing the technical period label with its date range, there were **three separate visual confirmations**, not a new 21-case batch: desktop German dark, 320 px German light and 320 px English dark, the mobile cases with root text at 200%. All three were visually inspected and had zero overflow/page errors. The initial functional scenario was not repeated by this confirmation batch; the final 203-test run includes the functional assertions after the label change. The confirmation console has a generic `functional: passed` message; the authoritative JSON correctly states `functional: not repeated`.

Raw logs, screenshots and manifests are under `desktop/.impeccable/review/native-us-tax-readiness/`. The versioned scoped proof is `docs/evidence/native-us-tax-readiness-20261008.json`; it contains final source hashes and hashes/paths for the ignored raw artifacts. The screenshots are local browser evidence, not physical-device, installed-native, live-provider or production evidence.

## Remaining limits

The native Rust port is source-only pending a permitted native compilation environment. The isolated browser provider is a declared mock, not an observed production tax provider. No live tax credentials, US production grant, migration, release, native distribution, subscription changes, Cargo run or security-policy workaround occurred. The web/server provider checks belong to the separate parent lot. This feature cannot be called certified tax compliance, US GAAP certification, or production readiness on this evidence.
